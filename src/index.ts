import {createSocket, Socket} from 'dgram';
import {writePacket} from "osc";
import {createServer, IncomingMessage, ServerResponse} from "http";
import * as fs from "fs";
import {promises as fsp} from "fs";
import {constants} from "http2";
import path from "path";
import * as os from "os";
import * as zod from 'zod';

/**
 * The valid locations for a configuration on the machine. The linux based path is removed if the platform is not
 * identified as linux
 */
const CONFIG_PATHS: string[] = [
    os.platform() === 'linux' ? '/etc/ents/x32-reflector.json' : undefined,
    os.platform() === 'linux' ? path.join('~', '.x32-reflector.config.json') : undefined,
    path.join(__dirname, '..', 'config', 'config.json'),
].filter((e) => e !== undefined) as string[];

/**
 * The validator for the configuration which contains udp and http bind and listen ports as well as timeouts for pairs
 */
const CONFIG_VALIDATOR = zod.object({
    udp: zod.object({
        bind: zod.string(),
        port: zod.number(),
    }),
    http: zod.object({
        bind: zod.string(),
        port: zod.number(),
    }),
    x32: zod.object({
        ip: zod.string(),
        port: zod.number(),
    }),
    timeout: zod.number(),
    siteRoot: zod.string().regex(/\/$/, {message: 'Path must end in a /'}).default('/'),
});
type Configuration = zod.infer<typeof CONFIG_VALIDATOR>;

/**
 * The root of the site to be used for url parsing and url generation
 */
let siteRoot = '/';

/**
 * HTML main site template loaded from file. Content is cached so program will have to be restarted to pick up new
 * changes in the file
 */
const TEMPLATE = fs.readFileSync('res/index.html', {encoding: 'utf8'});

/**
 * The currently loaded configuration
 */
let configuration: Configuration | undefined;

/**
 * The target to which incoming OSC packets should be resent. A tuple of ip and port
 */
let reflectorTargets: [string, number, number][] = [];
/**
 * The timer for the x32 checkin function, if started. Can be used to cancel the loop in the event the server needs
 * to disconnect
 */
let x32CheckinInterval: NodeJS.Timeout | undefined;

/**
 * The IP address of the x32 device
 */
let X32_ADDRESS = '10.1.10.20';
/**
 * The port of the x32 device
 */
let X32_PORT = 10023;

/**
 * Attempts to load the configuration from disk and return it if one is found as a safely parsed object. If no config
 * can be loaded it will throw an error
 */
async function loadConfiguration(): Promise<Configuration> {
    for (const file of CONFIG_PATHS) {
        let content;

        // Try and read file from disk
        try {
            content = await fsp.readFile(file, {encoding: 'utf8'});
        } catch (e) {
            console.warn(`Could not load configuration file ${file} due to an error: ${e}`)
            continue;
        }

        // Parse it as JSON and fail it out if its not
        try {
            content = JSON.parse(content);
        } catch (e) {
            console.warn(`Failed to load the JSON data at path ${file} due to error: ${e}`);
            continue;
        }

        // Try and parse it as a config file and reject if the file was not valid with the zod errors7
        // Try and be as helpful with the output as possible
        let safeParse = CONFIG_VALIDATOR.safeParse(content);
        if (!safeParse.success) {
            const reasons = safeParse.error.message + safeParse.error.errors.map((e) => `${e.message} (@ ${e.path.join('.')}`).join(', ');
            console.warn(`Content in ${file} is not valid: ${reasons}`);
            continue;
        }

        return safeParse.data;
    }

    throw new Error(`No valid configuration found, scanned: ${CONFIG_PATHS.join(', ')}`);
}

/**
 * Transmits an osc '/xremote' packet to the x32 device using the socket provided. This should trigger x32 to begin
 * sending all updates to the client. This returns a function which should be used in the interval or call rather than
 * directly
 * @param x32Socket the socket on which the messages should be sent
 */
function x32Checkin(x32Socket: Socket) {
    return () => {
        const array = writePacket({
            address: '/xremote',
        });
        const transmit = Buffer.from(array);

        x32Socket.send(transmit, X32_PORT, X32_ADDRESS, logSend(X32_ADDRESS, X32_PORT));
    }
}

/**
 * Returns a callback function handling errors as the first parameter. In the event error is non-null it will log
 * the address it failed to forward to and error which raised the error
 * @param address the address to which this send is being made
 * @param port the port to which this send is being made
 */
function logSend(address: string, port: number) {
    return (error: Error | null) => {
        if (error) {
            console.error(`Failed to forward to address ${address}:${port}`);
            console.error(error);
            return;
        }
    }
}

/**
 * Directly forwards the message parameter to all ip address and port combinations defined in {@link reflectorTargets}.
 * There is no additional parsing or manipulation of the packets
 * @param x32Socket the socket on which the messages should be sent
 */
function onReceiveFromX32(x32Socket: Socket) {
    return (message: Buffer) => {
        reflectorTargets.forEach(([address, port]) => x32Socket.send(message, port, address, logSend(address, port)));
    };
}

/**
 * HTTP handler
 *
 * Registers a new reflector target. This will add the ip and port combination to {@link reflectorTargets} and then
 * return a 301 response redirecting the user back to the home page
 * @param ip the ip address which should be added
 * @param port the port which should be added
 * @param res the http response to which the redirect response should be written
 */
function register(ip: string, port: number, res: ServerResponse) {
    reflectorTargets.push([ip, port, Date.now()]);

    // Redirect back to index
    res.writeHead(301, {
        Location: siteRoot,
    }).end();
}

/**
 * Attempts to remove the given ip address port combination from the {@link reflectorTargets}. If the ip address and
 * port are not present in the array, it will return a temporary redirect to the homepage with an error string as a
 * query parameter. If there are more than one of the same ip port combinations then only one will be removed. If the
 * remove is successful a temporary redirect to / without any error components will take place
 * @param ip the ip address which should be removed
 * @param port the port address should be removed
 * @param res the response on which the response should be send.
 */
function remove(ip: string, port: number, res: ServerResponse) {
    const index = reflectorTargets.findIndex(([i, p]) => i === ip && p === port);
    if (index === -1) {
        res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
            Location: `${siteRoot}?error=${encodeURIComponent('Unknown IP and Port combination')}`,
        }).end();
        return;
    }

    reflectorTargets.splice(index, 1);

    res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
        Location: siteRoot,
    }).end();
}

/**
 * Returns the formatted index page to the response with the table of values and error messages substituted in. This
 * uses the pre-loaded {@link TEMPLATE} so new changes to file will not be visible.
 * @param error the error message if one is provided in the query parameters
 * @param res the response to which the html should be written
 */
function index(error: string | null | undefined, res: ServerResponse) {
    if (configuration === undefined) {
        res.writeHead(constants.HTTP_STATUS_INTERNAL_SERVER_ERROR).write('Configuration is not loaded');
        res.end();
        return;
    }

    // Record the time in milliseconds records are allowed to exist
    const timeout = configuration.timeout * 60000;

    const table = reflectorTargets.map(([ip, port, created]) => `
        <tr>
            <td>${ip}</td>
            <td>${port}</td>
            <td>
                <a href="${siteRoot}remove?ip=${encodeURIComponent(ip)}&port=${encodeURIComponent(port)}">Delete</a>
            </td>
            <td>
                ${(timeout - (Date.now() - created)) / 1000}
            </td>
            <td>
                <a href="${siteRoot}renew?ip=${encodeURIComponent(ip)}&port=${encodeURIComponent(port)}">Renew</a>
            </td>
        </tr>`).join('');

    const template = TEMPLATE
        .replace('{{ERROR_INSERT}}', error ? `<p id="error">${error}</p>` : '')
        .replace('{{TABLE_INSERT}}', table);

    res.writeHead(constants.HTTP_STATUS_OK, {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    })
        .write(template)
    res.end();
}

/**
 * Attempts to renew the first entry which matches the given ip and port. This will only update one. In th event the
 * pairing is not found it will redirect to / with an error query parameter. On success it will redirect to / without
 * an error component. This updates the final entry in the tuple to Date.now() to reset the clock on the timeout
 * @param ip the ip address to query
 * @param port the port to query
 * @param res the response to which the redirects should be written
 */
function renew(ip: string, port: number, res: ServerResponse) {
    const index = reflectorTargets.findIndex(([i, p]) => i === ip && p === port);
    if (index === -1) {
        res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
            Location: `${siteRoot}?error=${encodeURIComponent('Unknown IP and Port combination')}`,
        }).end();
        return;
    }

    reflectorTargets[index] = [reflectorTargets[index][0], reflectorTargets[index][1], Date.now()];

    res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
        Location: siteRoot,
    }).end();
}

/**
 * Attempts to parse the ip address and port from the query parameters and validate them before dispatching them to
 * one of {@link register} or {@link remove} depending on the path. This will ensure that ip and port are present, that
 * port is a number between 1 and 65535, and that ip address matches a basic regex. In the event of an error it will use
 * a 301 code with an error query parameter
 * @param path the path on which this request was received, used to direct the function to call with parameters
 * @param query the query arguments in the URL which should be queried for the ip and port
 * @param res the response to which any error should be written, and which should be passed to other functions.
 */
function tryParseAttributes(path: '/register' | '/remove' | '/renew', query: URLSearchParams, res: ServerResponse) {
    // Verify that IP address is present
    let ip = query.get('ip');
    if (!query.has('ip') || ip === null) {
        res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
            Location: `${siteRoot}?error=${encodeURIComponent('IP address not specified')}`
        }).end();
        return;
    }

    // Verify that port is present
    let num = query.get('port');
    if (!query.has('port') || num === null) {
        res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
            Location: `${siteRoot}?error=${encodeURIComponent('Port not specified')}`
        }).end();
        return;
    }

    // Verify that port is numeric
    let port: number;
    try {
        port = Number(num);
    } catch (e) {
        res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
            Location: `${siteRoot}?error=${encodeURIComponent('Invalid port - not a number')}`
        }).end();
        return;
    }

    // Verify port is within valid range
    if (port < 1 || port > 65535) {
        res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
            Location: `${siteRoot}?error=${encodeURIComponent('Invalid port - out of range')}`
        }).end();
        return;
    }

    // Verify that IP address is of correct format
    if (!/^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)(\.(?!$)|$)){4}$/.test(ip)) {
        res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
            Location: `${siteRoot}?error=${encodeURIComponent('Invalid IP address - did not match regex')}`
        }).end();
        return;
    }

    // Dispatch
    if (path === '/remove') remove(ip, port, res);
    else if (path === '/register') register(ip, port, res);
    else if (path === '/renew') renew(ip, port, res);
}

/**
 * Handle an incoming HTTP request. This will parse the {@link IncomingMessage#url} using {@link URL} using
 * the host header. From this the {@link URL#pathname} is used to direct execution. In the event that no path matches
 * it will return a 404 error
 * @param req the original request from the http server
 * @param res the response to which the output should be written
 */
function handleHTTP(req: IncomingMessage, res: ServerResponse) {
    if (req.url === undefined) {
        res.writeHead(constants.HTTP_STATUS_BAD_REQUEST)
            .end();
        return;
    }

    // noinspection HttpUrlsUsage
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    const lowerPath = parsed.pathname.toLowerCase();
    switch (lowerPath) {
        case '/register':
        case '/remove':
        case '/renew':
            tryParseAttributes(lowerPath, parsed.searchParams, res);
            break;
        case '/':
            index(parsed.searchParams ? parsed.searchParams.get('error') : undefined, res);
            break;
        default:
            res.writeHead(constants.HTTP_STATUS_NOT_FOUND).end();
    }
}

function cleanup(config: Configuration) {
    return () => {
        reflectorTargets = reflectorTargets.filter(([, , created]) => {
            return Date.now() - created < config.timeout * 60000;
        });
    }
}

loadConfiguration().then((config) => {
    // Load in the ip and port from file to overwrite the default
    X32_PORT = config.x32.port;
    X32_ADDRESS = config.x32.ip;
    siteRoot = config.siteRoot;
    configuration = config;
    // Construct a HTTP server and make it listen on all interfaces on port 1325
    const httpServer = createServer(handleHTTP);
    httpServer.listen(config.http.port, config.http.bind);

    // Create a UDP socket and bind it to 1324. This will be used to send and receive from X32 as it requires a bound port
    // Then bind the receive function and start checking in every 9 seconds.
    // X32 requires check in every 10 seconds but to make sure that the clocks run over time and we miss parameters, use
    // 9 seconds so its slightly more frequent than required.
    const x32Socket = createSocket({
        type: 'udp4',
    });
    x32Socket.bind(config.udp.port, config.udp.bind);
    x32Socket.on('message', onReceiveFromX32(x32Socket));
    x32CheckinInterval = setInterval(x32Checkin(x32Socket), 9000);
    x32Checkin(x32Socket)();

    // Cleanup old addresses
    setInterval(cleanup(config), 60000);
})

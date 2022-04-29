import {createSocket, Socket} from 'dgram';
import {writePacket} from "osc";
import {createServer, IncomingMessage, ServerResponse} from "http";
import * as fs from "fs";
import {promises as fsp} from "fs";
import {constants} from "http2";
import path from "path";
import * as os from "os";
import * as zod from 'zod';
import {Configuration, loadConfiguration, TEMPLATE, X32Instance} from "./config/configuration";
import {logSend} from "./utils";

/**
 * The root of the site to be used for url parsing and url generation
 */
let siteRoot = '/';

/**
 * The currently loaded configuration
 */
let configuration: Configuration | undefined;

/**
 * The target to which incoming OSC packets should be resent. A tuple of ip and port
 */
let reflectorTargets: Record<string, [string, number, number][]> = {};
/**
 * The timer for the x32 checkin function, if started. Can be used to cancel the loop in the event the server needs
 * to disconnect
 */
let x32CheckinInterval: NodeJS.Timeout | undefined;

let x32Devices: (X32Instance & { socket: Socket })[] = [];

/**
 * Converts a device to a fixed ID which is unique to this instance
 * @param device
 */
const deviceToID = (device: X32Instance) => `${device.name ?? ''}#${device.ip}#${device.port}`;

const deviceToHuman = (device: X32Instance) => genericDeviceToHuman(device.name, device.ip, String(device.port));
const reflectorKeyToHuman = (id: string) => {
    let strings = id.split('#');
    if (strings.length !== 3) throw new Error('invalid number of indexes');
    return genericDeviceToHuman(strings[0], strings[1], strings[2]);
}
const genericDeviceToHuman = (name: string|undefined, ip: string, port: string) => (name ?? '').length === 0 ? `${ip}:${port}` : `${name} (${ip}:${port})`;

/**
 * Transmits an osc '/xremote' packet to all x32 devices using the socket stored in {@link x32Devices}. This should
 * trigger x32 to begin sending all updates to the clients.
 */
function x32Checkin() {
    const array = writePacket({
        address: '/xremote',
    });
    const transmit = Buffer.from(array);

    x32Devices.forEach(({socket, ip, port}) => socket.send(transmit, port, ip, logSend(ip, port)));
}



/**
 * Directly forwards the message parameter to all ip address and port combinations defined in {@link reflectorTargets}.
 * There is no additional parsing or manipulation of the packets
 * @param device the device, including socket, to which the messages should be sent
 */
function onReceiveFromX32(device: (typeof x32Devices)[number]) {
    return (message: Buffer) => {
        reflectorTargets[deviceToID(device)].forEach(([address, port]) => device.socket
            .send(message, port, address, logSend(address, port)));
    };
}

/**
 * Attempts to find the x32 instance on the given IP and port. If found it will return its key in
 * {@link reflectorTargets}. Otherwise it will redirect to home page with an error and return null.
 * @param x32IP the ip address of the x32 instance being interacted with
 * @param x32Port the port of the x32 instance being interacted with
 * @param res the response to which the error should be written
 */
function findKeyOrFail(x32IP: string, x32Port: number, res: ServerResponse): string | null {
    const key = Object.keys(reflectorTargets).find((e) => {
        const [,i, p] = e.split('#');
        console.log(i, '===', x32IP, '&&', p, '===', String(x32Port));
        return i === x32IP && p === String(x32Port);
    });

    if (key === undefined) {
        res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
            Location: `${siteRoot}?error=${encodeURIComponent('Unknown X32 IP and Port combination')}`,
        }).end();
        return null;
    }

    return key;
}

/**
 * HTTP handler
 *
 * Registers a new reflector target. This will add the ip and port combination to {@link reflectorTargets} and then
 * return a 301 response redirecting the user back to the home page
 * @param x32IP the ip address of the x32 instance being interacted with
 * @param x32Port the port of the x32 instance being interacted with
 * @param ip the ip address which should be added
 * @param port the port which should be added
 * @param res the http response to which the redirect response should be written
 */
function register(x32IP: string, x32Port: number, ip: string, port: number, res: ServerResponse) {
    console.log('Trying client', x32IP, x32Port, ip, port);
    const key = findKeyOrFail(x32IP, x32Port, res);
    if (key === null) return;

    let find = reflectorTargets[key].find(([tIp, tPort]) => tIp === ip && tPort === port);
    if (find !== undefined) {
        res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
            Location: `${siteRoot}?error=${encodeURIComponent('Device is already registered on this device')}`,
        }).end();
        return;
    }

    console.log('Added client');

    reflectorTargets[key].push([ip, port, Date.now()]);

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
 * @param x32IP the ip address of the x32 instance being interacted with
 * @param x32Port the port of the x32 instance being interacted with
 * @param ip the ip address which should be removed
 * @param port the port address should be removed
 * @param res the response on which the response should be send.
 */
function remove(x32IP: string, x32Port: number, ip: string, port: number, res: ServerResponse) {
    const key = findKeyOrFail(x32IP, x32Port, res);
    if (key === null) return;

    const originalLength = reflectorTargets[key].length;
    reflectorTargets[key] = reflectorTargets[key].filter(([tIp, tPort]) => tIp !== ip && tPort !== port);

    if (originalLength === reflectorTargets[key].length) {
        res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
            Location: `${siteRoot}?error=${encodeURIComponent('Unknown IP and Port combination')}`,
        }).end();
        return;
    }

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

    let tables = [];
    for (const [key, value] of Object.entries(reflectorTargets)) {
        const [, xIP, xPort] = key.split('#');
        const xQuery = `&x32Port=${decodeURIComponent(xPort)}&x32IP=${encodeURIComponent(xIP)}`;
        const tableRows = value.map(([ip, port, created]) => `
        <tr>
            <td>${ip}</td>
            <td>${port}</td>
            <td>
                <a href="${siteRoot}remove?ip=${encodeURIComponent(ip)}&port=${encodeURIComponent(port)}${xQuery}">Delete</a>
            </td>
            <td>
                ${(timeout - (Date.now() - created)) / 1000}
            </td>
            <td>
                <a href="${siteRoot}renew?ip=${encodeURIComponent(ip)}&port=${encodeURIComponent(port)}${xQuery}">Renew</a>
            </td>
        </tr>`).join('');

        tables.push(`<h3>Instance ${reflectorKeyToHuman(key)}</h3>
                    <table>
                        <tr>
                            <th>IP Address</th>
                            <th>Port</th>
                            <th></th>
                            <th>Time Remaining (s)</th>
                            <th></th>
                        </tr>
                        ${tableRows}
                    </table>`);
    }

    const devices = x32Devices.map((device) =>
        `<option value="${device.ip}#${device.port}">${deviceToHuman(device)}</option>`
    ).join('');

    const template = TEMPLATE
        .replace('{{ERROR_INSERT}}', error ? `<p class="error">${error}</p>` : '')
        .replace('{{DEVICES}}', devices)
        .replace('{{TABLE_INSERT}}', tables.join('<hr/>'));

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
 * @param x32IP the ip address of the x32 instance being interacted with
 * @param x32Port the port of the x32 instance being interacted with
 * @param ip the ip address to query
 * @param port the port to query
 * @param res the response to which the redirects should be written
 */
function renew(x32IP: string, x32Port: number, ip: string, port: number, res: ServerResponse) {
    const key = findKeyOrFail(x32IP, x32Port, res);
    if (key === null) return;

    const find = reflectorTargets[key].find(([i, p]) => i === ip && p === port);
    if (!find) {
        res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
            Location: `${siteRoot}?error=${encodeURIComponent('Unknown IP and Port combination')}`,
        }).end();
        return;
    }

    find[2] = Date.now();

    res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
        Location: siteRoot,
    }).end();
}

/**
 * Tries to fetch the parameter with name from the query. If it is not present or null it will return an error
 * directly to the response and return null. Otherwise it returns the value
 * @param query the query parameters to be searched
 * @param name the name of the entry to try and fetch
 * @param res the response on which the error should be written if needed
 * @return the value or null if not present
 */
const get = (query: URLSearchParams, name: string, res: ServerResponse) => {
    let data = query.get(name);
    if (!query.has(name) || data === null) {
        res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
            Location: `${siteRoot}?error=${encodeURIComponent(`${name} not specified`)}`
        }).end();
        return null;
    }

    return data;
}

/**
 * Attempts to convert the data from the query parameter with the given name to a port by convering to number and
 * bounds checking it. If it fails it will write an error directly to the response
 * @param data the value loaded from params
 * @param name the id of the param
 * @param res the server response
 * @return the cast port or null if it failed and an error was returned
 */
const convertToPort = (data: string, name: string, res: ServerResponse) => {
    // Verify that port is numeric
    let port: number;
    try {
        port = Number(data);
    } catch (e) {
        res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
            Location: `${siteRoot}?error=${encodeURIComponent(`Invalid ${name} - not a number`)}`
        }).end();
        return null;
    }

    // Verify port is within valid range
    if (port < 1 || port > 65535) {
        res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
            Location: `${siteRoot}?error=${encodeURIComponent('Invalid ${name} - out of range')}`
        }).end();
        return null;
    }

    return port;
}

/**
 * Performs Regex validation against the data to match it to an IP. If it fails it will write an error to the response
 * and return null
 * @param data the ip to test
 * @param name the name of the query it was pulled from
 * @param res the response on which the error should be written if needed
 * @return null if not an ip  or the value of data
 */
const convertToIP = (data: string, name: string, res: ServerResponse) => {
    const IP_REGEX = /^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)(\.(?!$)|$)){4}$/;
    // Verify that IP address is of correct format
    if (!IP_REGEX.test(data)) {
        res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
            Location: `${siteRoot}?error=${encodeURIComponent(`Invalid IP address ${name} - did not match regex`)}`
        }).end();
        return null;
    }

    return data;
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
function tryParseAttributes(path: '/remove' | '/renew', query: URLSearchParams, res: ServerResponse) {

    // Verify that IP address is present
    const ip = get(query, 'ip', res);
    if (ip === null) return;

    // Verify that port is present
    let num = get(query, 'port', res);
    if (num === null) return;

    // Convert to number
    const port = convertToPort(num, 'port', res);
    if (port === null) return;

    // Verify that IP address is present
    const x32Ip = get(query, 'x32IP', res);
    if (x32Ip === null) return;

    // Verify that port is present
    let x32PortRaw = get(query, 'x32Port', res);
    if (x32PortRaw === null) return;

    // Convert to number
    const x32Port = convertToPort(x32PortRaw, 'x32Port', res);
    if (x32Port === null) return;

    if (convertToIP(ip, 'ip', res) === null || convertToIP(x32Ip, 'x32IP', res) === null) return;

    // Dispatch
    if (path === '/remove') remove(x32Ip, x32Port, ip, port, res);
    // else if (path === '/register') register(x32Ip, x32Port, ip, port, res);
    else if (path === '/renew') renew(x32Ip, x32Port, ip, port, res);
}

function registerHTTP(query: URLSearchParams, res: ServerResponse) {
// Verify that IP address is present
    const ip = get(query, 'ip', res);
    if (ip === null) return;

    // Verify that port is present
    let num = get(query, 'port', res);
    if (num === null) return;

    // Verify device was present
    let device = get(query, 'device', res);
    if (device === null) return;

    // Convert to number
    const port = convertToPort(num, 'port', res);
    if (port === null) return;

    if (convertToIP(ip, 'ip', res) === null) return;

    if (!/.+#[0-9]+/.test(device)) {
        res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
            Location: `${siteRoot}?error=${encodeURIComponent(`Invalid device - did not match regex`)}`
        }).end();
        return null;
    }

    const [xi, xp] = device.split('#');
    const xPort = convertToPort(xp, 'port', res);
    if (xPort === null || convertToIP(xi, 'ip', res) === null) return;

    register(xi, xPort, ip, port, res);
    return;
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
            registerHTTP(parsed.searchParams, res);
            break;
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
        for (const key of Object.keys(reflectorTargets)) {
            reflectorTargets[key] = reflectorTargets[key].filter(([, , created]) => {
                return Date.now() - created < config.timeout * 60000;
            });
        }
    }
}

loadConfiguration().then(async (config) => {
    // Load in the ip and port from file to overwrite the default
    siteRoot = config.siteRoot;
    configuration = config;
    // Construct a HTTP server and make it listen on all interfaces on port 1325
    const httpServer = createServer(handleHTTP);
    httpServer.listen(config.http.port, config.http.bind);

    // Create a UDP socket and bind it to 1324. This will be used to send and receive from X32 as it requires a bound port
    // Then bind the receive function and start checking in every 9 seconds.
    // X32 requires check in every 10 seconds but to make sure that the clocks run over time and we miss parameters, use
    // 9 seconds so its slightly more frequent than required.
    const promises = [];
    for (const instance of Array.isArray(config.x32) ? config.x32 : [config.x32]) {
        const socket = createSocket({
            type: 'udp4',
        });
        socket.on('error', console.error);
        promises.push(new Promise<void>((res, rej) => {
            socket.once('error', () => rej());
            socket.bind(undefined, config.udp.bind, () => {
                const mapping = {socket, ...instance};
                x32Devices.push(mapping);
                reflectorTargets[deviceToID(instance)] = [];

                socket.on('message', onReceiveFromX32(mapping));

                console.log(`X32 ${instance.ip}:${instance.port} is bound to ${config.udp.bind}:${socket.address().port}`);
                res();
            });
        }))
    }

    await Promise.all(promises);

    x32CheckinInterval = setInterval(x32Checkin, 9000);
    x32Checkin();

    // Cleanup old addresses
    setInterval(cleanup(config), 60000);
})

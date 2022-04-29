import {writePacket} from "osc";
import {createSocket, Socket} from "dgram";
import {Configuration, loadConfiguration, X32Instance, X32InstanceWithSocket} from "../config/configuration";
import {logSend} from "../utils";

type CreateSocketFunction = typeof createSocket;

/**
 * A promisified version of {@link Socket#bind}. This will resolve with the socket or reject with an
 * error if one is raised.
 * @param socket the socket on which this should be called
 * @param port the port on which this socket should bind or undefined if the OS should select it
 * @param address the address on which the socket should bind
 * @return a promise containing the socket
 */
function promisifyBind(socket: Socket, port?: number, address?: string) {
    return new Promise<Socket>((resolve, reject) => {
        // Going to use a roundabout error handling method here to make a cancellable error handler
        // Generate a random event name unique to this socket (not actually necessary but why not)
        const event = `a${Math.round(Math.random() * 1000)}`;

        // Redirect all error events through to this custom event. This can keep running forever
        // without impact to any other services
        socket.on('error', (err) => socket.emit(event, err));

        // Then listen for one error on this event. This should only be emitted by `bind` because
        // that is all that is happening right now. We use null as a special object to mean 'clear'
        // so it does nothing. If an error is emitted by bind, we reject and that will remove the listener
        // as its just in a once call
        socket.once(event, (err: Error | null) => {
            if (err === null) return;
            reject(err);
        });

        socket.bind(port, address, () => {
            // If we reach this point the bind was successful so we can clear our error handler to
            // make sure we don't receive an unrelated error in the future which will try and reject
            // this promise that is already resolved. This will trigger the `once` handler above
            // but the null is handled to be suppressed
            socket.emit(event, null);

            // Once this is done, just resolve it and everything should be cleaned up
            resolve(socket);
        });
    });
}

/**
 * A target of a redirection containing the ip and port to which packets should be sent and the last time the device
 * checked in which should be used to produce its cleanup time
 */
export type Target = {
    ip: string,
    port: number,
    checkin: number,
};

export class State {

    /**
     * The configuration this state is currently running from
     * @private
     */
    private readonly _config: Configuration;
    /**
     * The set of redirection targets. This is a mapping of x32 device names to a list of targets to which packets
     * should be sent
     * @private
     */
    private readonly _targets: Record<string, Target[]>;
    /**
     * The interval which is being used to manage the  checkin protocols with X32 and device cleanup. If undefined it
     * means that no interval is currently running. See {@link launch} and ${@link stop}.
     * @private
     */
    private _interval: NodeJS.Timeout | undefined;
    /**
     * The set of devices that are currently running and 'connected' to
     * @private
     */
    private _devices: X32InstanceWithSocket[];
    /**
     * The function which should be used to create UDP sockets. This is designed to support test mocking
     * @private
     */
    private readonly _create: CreateSocketFunction;

    /**
     * Creates a new state object, loading the configuration via {@link loadConfiguration}. If a create function is
     * specified, that will be used instead of the default dgram {@link createSocket} function.
     * @param create the optional function which should be used to create UDP sockets. Defaults to dgram default
     */
    public static async makeState(create: CreateSocketFunction = createSocket) {
        return new State(await loadConfiguration(), create);
    }

    /**
     * Creates a new state and registers all devices contained in the config. {@link launch} is not called which means
     * this will not begin checkins
     * @param config the configuration which should be used for this state
     * @param create the optional function which should be used to create UDP sockets. Defaults to dgram default
     */
    constructor(config: Configuration, create: CreateSocketFunction = createSocket) {
        this._create = create;
        this._config = config;
        this._targets = {};
        this._devices = [];

        this.checkin = this.checkin.bind(this);
        this.receive = this.receive.bind(this);
        this.cleanup = this.cleanup.bind(this);

        if (Array.isArray(this._config.x32)) {
            this._config.x32.forEach((device) => this.register(device));
        } else {
            void this.register(this._config.x32);
        }
    }

    /**
     * Sends a check in message to all devices contained in {@link _devices}. This is an OSC packet to `/xremote`
     * triggering the x32 device to start sending all updates to this server.
     * @private
     */
    private checkin(): void {
        const array = writePacket({
            address: '/xremote',
        });
        const transmit = Buffer.from(array);

        this._devices.forEach(
            ({socket, ip, port}) => socket.send(
                transmit,
                port,
                ip,
                logSend(ip, port),
            )
        );
    }

    /**
     * Begins sending check in messages every 9 seconds to every device contained in {@link _devices}. This sends the
     * messages using {@link checkin}. Will raise an error if checkins have already been started
     */
    public launch() {
        if (this._interval !== undefined) throw new Error('Interval has already been launched');
        console.log('[state]: launching');
        this._interval = setInterval(() => {
            this.checkin();
            this.cleanup();
        }, 9000);
    }

    /**
     * Stops sending check in messages every 9 seconds to all devices. This will clear the interval allowing
     * {@link launch} to be called again.
     */
    public stop() {
        if (this._interval === undefined) throw new Error('Interval has not been set, have you called launch()');
        console.log('[state]: stopping');
        clearInterval(this._interval);
        this._interval = undefined;
    }

    /**
     * Registers a new device and attempts to form a new socket, binding the socket with a random port. This will
     * insert it into the currently running devices which will immediately be included in broadcasts by {@link checkin}.
     * @param device the device to register
     */
    public async register(device: X32Instance): Promise<void> {
        const socket = this._create({type: 'udp4'});
        const entity = {...device, socket};

        await promisifyBind(socket, undefined, this._config.udp.bind);
        socket.on('message', (m) => this.receive(entity, m))

        console.log(`[state]: registered x32 device at ${device.ip}:${device.port} under ${device.name}`)

        this._devices.push(entity);
        this._targets[device.name] = [];
    }

    /**
     * Sets up a new redirection from an x32 device identified by the name `from` and send all data to the target
     * ip address (`to`) and port (`port`). This should take effect immediately. This will raise an exception if the
     * device does not exist
     * @param from the source device name
     * @param to the redirect target IP address
     * @param port the redirect target port
     */
    public redirect(from: string, to: string, port: number) {
        if (this._targets[from] === undefined) throw new Error('Unknown device');
        this._targets[from].push({
            ip: to,
            port,
            checkin: Date.now(),
        });

        console.log(`[state]: changes from ${from} are being redirected to ${to}:${port}`);
    }

    /**
     * Removes a redirection from the system. Will raise an error if the device or or target is not present
     * @param from the source device name
     * @param to the redirect target IP address
     * @param port the redirect target port
     */
    public unredirect(from: string, to: string, port: number) {
        if (this._targets[from] === undefined) throw new Error('Unknown device');
        const before = this._targets[from].length;
        this._targets[from] = this._targets[from].filter((redirect) => !(redirect.ip === to && redirect.port === port));
        if (this._targets[from].length === before) throw new Error('Unknown redirect target');
        console.log(`[state]: changes from ${from} are no longer being redirected to ${to}:${port}`);
    }

    /**
     * Attempts to renew the given client to not be removed by the automatic cleanup
     * @param from the source device name
     * @param to the redirect target IP address
     * @param port the redirect target port
     */
    public renew(from: string, to: string, port: number) {
        if (this._targets[from] === undefined) throw new Error('Unknown device');
        let changed = false;
        this._targets[from].forEach((entity) => {
            if (entity.ip === to && entity.port === port) {
                entity.checkin = Date.now();
                changed = true;
            }
        });
        if (!changed) throw new Error('Unknown redirect target');
        console.log(`[state]: ${to}:${port} has renewed itself against ${from}`);
    }

    /**
     * On receive of a message the x32 device in the first argument with the message buffer. This will send it to all
     * of the registered redirect clients.
     * @param source the source from which the message was received, with socket for sending
     * @param message the message received from the x32 device
     * @private
     */
    private receive(source: X32InstanceWithSocket, message: Buffer) {
        if (this._targets[source.name] === undefined) return;
        this._targets[source.name].forEach((entity) => {
            source.socket.send(message, entity.port, entity.ip, logSend(entity.ip, entity.port));
        });
    }

    /**
     * Removes all reflector targets that have not checked in within a reasonable amount of time
     * @private
     */
    private cleanup() {
        for (const key of this.devices) {
            this._targets[key.name] = this._targets[key.name].filter(({checkin}) => {
                return Date.now() - checkin < this._config.timeout * 60000;
            });
        }
    }

    /**
     * Returns the configuration currently in use by this state
     * @return the configuration in use
     */
    get configuration() {
        return this._config;
    }

    /**
     * Returns the set of devices currently being communicated with.
     * @return the devices curently in use, this does not include their sockets
     */
    get devices(): X32Instance[] {
        return this._devices.map((e) => ({
            name: e.name,
            ip: e.ip,
            port: e.port,
        }));
    }

    /**
     * Return this clients which are receiving redirects from the specified device. Raises an error if the device does
     * not exist
     * @param device the device to lookup
     * @return a list of targets to which data is being redirected
     */
    public clients(device: string): Target[] {
        if (this._targets[device] === undefined) throw new Error('Unknown device');
        return this._targets[device];
    }
}
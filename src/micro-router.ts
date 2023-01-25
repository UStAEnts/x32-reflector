import {IncomingMessage, ServerResponse} from "http";
import {constants} from "http2";
import { Configuration } from "./config/configuration";

/**
 * If additional debugging messages should be logged for interactions with the HTTP server
 */
const DEBUG_LOG = (process.env.NODE_ENV ?? 'production') === 'dev';
/**
 * An alias for debug logging which will only print a message if {@link DEBUG_LOG} is true
 * @param message the message to log
 */
const d = (message: string) => DEBUG_LOG && console.log(`[router|DEBUG]: ${message}`);

/**
 * The supported HTTP method types as a type
 */
export type Method = 'GET' | 'POST';
/**
 * The supported HTTP methods as an array
 */
const SUPPORTED_METHODS: Method[] = ['GET', 'POST'];

/**
 * The type for a basic route containing properties that all routes will need. In this case it is a path which can be a
 * string or a regex which will be applied to the pathname region of a URL. If a fail function is specified then it will
 * be used in the event of an error instead of sending directly so custom processing can take place
 */
type BaseRoute = {
    path: string | RegExp;
    fail?: (res: ServerResponse, code: number, error: string) => void;
}

/**
 * A key based validator is a check run against a property of an object or query parameter.
 */
type KeyBasedValidator = {
    /**
     * The name of the property to which the validator will need to be applied
     */
    name: string;
    /**
     * The validation function which should do some processing against the loaded value. This will return true or false
     * to whether the value is acceptable or reject in the event of a promise.
     * @param value the value which should be processed
     */
    validator: (value: string) => boolean | PromiseLike<boolean> | Promise<boolean>;
    /**
     * The error message to use if the validator fails
     */
    error: string;
    /**
     * If the value is required to exist in the object
     */
    required: boolean;
}

/**
 * A get route, optionally supporting query validation
 */
export type GetRoute = BaseRoute & ({
    /**
     * A handler function accepting the query parameters and the route in use
     * @param path the path on which this handle function was activated
     * @param query the query parameters included in this request
     * @param res the response to which results should be written
     * @param req the request from which additional properties can be parsed
     */
    handle: (path: string, query: URLSearchParams, res: ServerResponse, req: IncomingMessage) => void | Promise<void> | PromiseLike<void>;
    /**
     * If the properties of the query parameters should be parsed
     */
    parseQuery: true;
    /**
     * The set of query validators that need to be applied to the query parameters
     */
    queryValidator: KeyBasedValidator[],
} | {
    /**
     * A handler function accepting the query parameters and the route in use
     * @param path the path on which this handle function was activated
     * @param query the query parameters included in this request
     * @param res the response to which results should be written
     * @param req the request from which additional properties can be parsed
     */
    handle: (path: string, query: URLSearchParams, res: ServerResponse, req: IncomingMessage) => void | Promise<void> | PromiseLike<void>;
    /**
     * If the properties of the query parameters should be parsed
     */
    parseQuery: false;
});


/**
 * A post route, optionally supporting validation of the body in JSON or text formats
 */
type PostRoute = BaseRoute & {
    /**
     * A handler function accepting the query parameters and the route in use and the body
     * @param path the path on which this handle function was activated
     * @param query the query parameters included in this request
     * @param body the body of the request as a string, ready for processing
     * @param res the response to which results should be written
     * @param req the request from which additional properties can be parsed
     */
    handle: (path: string, query: URLSearchParams, body: string, res: ServerResponse, req: IncomingMessage) => void | Promise<void> | PromiseLike<void>;
} & ({
    /**
     * Specifies the body should be parsed as JSON and have a key based validator applied to it. This requires the JSON
     * body to be an object. If you require any other types you will need to process it yourself through the text type
     */
    parseBody: 'json';
    /**
     * The set of validators which should be applied to the JSON body object
     */
    validator: KeyBasedValidator[],
} | {
    /**
     * Specifies the body should be parsed as raw text
     */
    parseBody: 'text';
    /**
     * The validator function which should be applied to the string body
     * @param body the body text
     * @return if the body is valid
     */
    validator: (body: string) => (boolean | Error) | PromiseLike<boolean> | Promise<boolean>,
})

/**
 * Joining of the supported route types
 */
type Route = GetRoute | PostRoute;
/**
 * The internally usable type which also attaches the method to the route
 */
type InternalRoute = Route & { method: Method };

/**
 * A utility function which fails by redirecting the request with the given error to / with the error provided as a
 * query parameter
 * @param res the response on which results should be written
 * @param error the error which should be included in the request
 */
export const fail = (res: ServerResponse, error: string, config: Configuration) => res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
    Location: `${config.http.prefix ?? ''}/?error=${encodeURIComponent(error)}`
}).end();

/**
 * A utility function which succeeds a request by redirecting it to / without an error parameter
 * @param res the response on which the redirect should be written
 */
export const succeed = (res: ServerResponse, config: Configuration) => res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
    Location: `${config.http.prefix ?? ''}/`
}).end();

/**
 * A basic (likely bugging) HTTP router supporting basic validation of requests before routing
 */
export default class MicroRouter {

    /**
     * The set of methods that currently have routes registered. This will be used to quickly reject unsupported
     * requests before sorting through the routers
     * @private
     */
    private _methodsInUse: Set<string>;
    /**
     * The set of routes which are currently registered on this router
     * @private
     */
    private _routes: InternalRoute[];

    constructor() {
        this._routes = [];
        this._methodsInUse = new Set();
    }

    /**
     * Registers a new get route. This will be placed at the bottom of the list of routes meaning any route that matches
     * before it will be used instead
     * @param route the route which should be registered
     */
    get(route: GetRoute): void {
        // @ts-ignore - eeeeeh its right but complicated? TODO?
        const r: InternalRoute = Object.assign(route, {method: 'GET'});
        this._routes.push(r);
        this._methodsInUse.add("GET");

        d(`added a new route for GET ${route.path}`);
    }

    /**
     * Registers a new post route. This will be placed at the bottom of the list of routes meaning any route that
     * matches before it will be used instead
     * @param route the route which should be registered
     */
    post(route: Omit<PostRoute, 'method'>): void {
        // @ts-ignore - eeeeeh its right but complicated? TODO?
        const r: InternalRoute = Object.assign(route, {method: 'POST'});
        this._routes.push(r);
        this._methodsInUse.add("POST");

        d(`added a new route for POST ${route.path}`);
    }

    /**
     * Handles an incoming message form the HTTP server
     * @param req the request which was received
     * @param res the response to which results should be written
     * @param next the function which should be called when an error occurs or a route is not found
     */
    async incoming(req: IncomingMessage, res: ServerResponse, next: () => void) {
        d(`got an incoming request for ${req.method} ${req.url}`);
        // Ensure method is valid
        if (req.method === undefined || !this._methodsInUse.has(req.method)) {
            d(`method was not specified or the method was unknown: ${req.method}`);
            next();
            return;
        }

        // And the URL is defined, not sure when this is not true but fail if its not
        if (req.url === undefined) {
            d(`url was not specified ${req.url}`);
            next();
            return;
        }

        // Reject requests immediately with an unsupported method
        if (!SUPPORTED_METHODS.includes(req.method as any) || this._methodsInUse.has(req.method)) {
            res.writeHead(constants.HTTP_STATUS_METHOD_NOT_ALLOWED).end();
            return;
        }

        // Caching this value now its type is refined to a string. This will ensure its usable inside arrow functions
        const urlInit = req.url;

        // Extract the query parameters and pathname from the url. We sub in the host here because URL will not parse it
        // otherwise
        const {pathname, searchParams} = new URL(urlInit, `http://${req.headers.host}`);

        // Then locate matching record
        const route = this._routes.find((route) =>
            route.method === req.method
            && (typeof (route.path) === 'string' ? route.path === pathname : route.path.test(pathname))
        );

        d(`identified route: ${route?.path}`)

        // If none are found push it on to the next one
        if (route === undefined) {
            d('no route was identified');
            next();
            return;
        }

        // And finally route it with its correct record
        if (route.method === 'GET') {
            await MicroRouter.incomingGet(pathname, route as GetRoute, searchParams, req, res);
        } else if (route.method === 'POST') {
            await MicroRouter.incomingPost(pathname, route as PostRoute, searchParams, req, res);
        }
    }

    /**
     * Utility function to close a request with the given status code and message in a single line
     * @param res the response which should be closed
     * @param status the status code is should be closed with
     * @param message the message which should be written in response
     * @private
     */
    private static close(res: ServerResponse, status: number, message: string) {
        res.statusCode = status;
        res.write(message);
        res.end();
    }

    /**
     * Handles an incoming get request being routed to the provided route. This will run any validators if they are
     * present
     * @param pathname the pathname on which this request was received
     * @param route the route which matched it
     * @param query the query parameters extracted
     * @param req the original request
     * @param res the output response
     * @private
     */
    private static async incomingGet(pathname: string, route: GetRoute, query: URLSearchParams, req: IncomingMessage, res: ServerResponse) {
        if (route.parseQuery) {
            // If the route needs the query validating, go through each validator and extract the key
            for (let keyBasedValidator of route.queryValidator) {
                const entry = query.get(keyBasedValidator.name);

                // If its not specified but required, immediately reject, optionally using the routes fail method if
                // specified
                if (entry === undefined || entry === null) {
                    if (keyBasedValidator.required) {
                        (route.fail ?? MicroRouter.close)(
                            res,
                            constants.HTTP_STATUS_BAD_REQUEST,
                            `query parameter ${keyBasedValidator.name} is required`,
                        );
                        return;
                    } else {
                        // Otherwise, continue because there is no more processing that can be done on this record
                        continue;
                    }
                }

                // If the validator returns false, or rejects, send the failure message, optionally using the provided
                // fail method
                if (!(await Promise.resolve(keyBasedValidator.validator(entry)).catch(() => false))) {
                    (route.fail ?? MicroRouter.close)(
                        res,
                        constants.HTTP_STATUS_BAD_REQUEST,
                        keyBasedValidator.error,
                    );
                    return;
                }
            }
        }

        // Otherwise if all the validators passed (none of them returned out of the function) then handle it
        route.handle(pathname, query, res, req);
    }

    /**
     * Handles an incoming post request being routed to the provided route. This will run any validators if they are
     * present
     * @param pathname the pathname on which this request was received
     * @param route the route which matched it
     * @param query the query parameters extracted
     * @param req the original request
     * @param res the output response
     * @private
     */
    private static async incomingPost(pathname: string, route: PostRoute, query: URLSearchParams, req: IncomingMessage, res: ServerResponse) {
        // Load the body
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (d) => body += d);

        // When the data is done being read, run the validators against it
        req.on('end', async () => {
            if (route.parseBody === 'text') {
                // If a text validator is provided, just run it against the string and fail if it doesn't pass
                if (!await Promise.resolve(route.validator(body)).catch(() => false)) {
                    (route.fail ?? MicroRouter.close)(
                        res,
                        constants.HTTP_STATUS_BAD_REQUEST,
                        'invalid body',
                    );
                    return;
                }
            } else if (route.parseBody === 'json') {
                // If it is JSON, try and parse it and then run the validators against it in the same way as the get
                // function. Read that if there are issues
                let data: any;
                try {
                    data = JSON.parse(body);
                } catch (e) {
                    (route.fail ?? MicroRouter.close)(
                        res,
                        constants.HTTP_STATUS_BAD_REQUEST,
                        'body json was invalid',
                    );
                    return;
                }

                if (typeof (data) !== 'object') {
                    (route.fail ?? MicroRouter.close)(
                        res,
                        constants.HTTP_STATUS_BAD_REQUEST,
                        'body json must be an object',
                    );
                    return;
                }

                for (let keyBasedValidator of data) {
                    const entry = data[keyBasedValidator.name];
                    if (entry === undefined || entry === null) {
                        if (keyBasedValidator.required) {
                            (route.fail ?? MicroRouter.close)(
                                res,
                                constants.HTTP_STATUS_BAD_REQUEST,
                                `body key ${keyBasedValidator.name} is required`,
                            );
                            return;
                        }
                    } else {
                        if (!(await keyBasedValidator.validator(entry))) {
                            (route.fail ?? MicroRouter.close)(
                                res,
                                constants.HTTP_STATUS_BAD_REQUEST,
                                keyBasedValidator.error,
                            );
                            return;
                        }
                    }
                }

            }

            route.handle(
                pathname,
                query,
                body,
                res,
                req,
            );
        });
    }
}
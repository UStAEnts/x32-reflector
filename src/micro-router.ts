import {IncomingMessage, ServerResponse} from "http";
import {constants} from "http2";

const DEBUG_LOG = (process.env.NODE_ENV ?? 'production') === 'dev';
const d = (message: string) => DEBUG_LOG && console.log(`[router|DEBUG]: ${message}`);

export type Method = 'GET' | 'POST';

type BaseRoute = {
    path: string | RegExp;
    fail?: (res: ServerResponse, code: number, error: string) => void;
}

type KeyBasedValidator = {
    name: string;
    validator: (value: string) => boolean | PromiseLike<boolean> | Promise<boolean>;
    error: string;
    required: boolean;
}

export type GetRoute = BaseRoute & ({
    handle: (path: string, query: URLSearchParams, res: ServerResponse, req: IncomingMessage) => void | Promise<void> | PromiseLike<void>;
    parseQuery: true;
    queryValidator: KeyBasedValidator[],
} | {
    handle: (path: string, query: URLSearchParams, res: ServerResponse, req: IncomingMessage) => void | Promise<void> | PromiseLike<void>;
    parseQuery: false;
});

type PostRoute = BaseRoute & {
    handle: (path: string, query: URLSearchParams, body: string, res: ServerResponse, req: IncomingMessage) => void | Promise<void> | PromiseLike<void>;
} & ({
    parseBody: 'json';
    validator: KeyBasedValidator[],
} | {
    parseBody: 'text';
    validator: (body: string) => (boolean | Error) | PromiseLike<boolean> | Promise<boolean>,
})

type Route = GetRoute | PostRoute;
type InternalRoute = Route & { method: Method };

export const fail = (res: ServerResponse, error: string) => res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
    Location: `/?error=${encodeURIComponent(error)}`
}).end();
export const succeed = (res: ServerResponse) => res.writeHead(constants.HTTP_STATUS_TEMPORARY_REDIRECT, {
    Location: `/`
}).end();

export default class MicroRouter {

    private _methodsInUse: Set<string>;
    private _routes: InternalRoute[];

    constructor() {
        this._routes = [];
        this._methodsInUse = new Set();
    }

    get(route: GetRoute): void {
        // @ts-ignore - eeeeeh its right but complicated? TODO?
        const r: InternalRoute = Object.assign(route, {method: 'GET'});
        this._routes.push(r);
        this._methodsInUse.add("GET");

        d(`added a new route for GET ${route.path}`);
    }

    post(route: Omit<PostRoute, 'method'>): void {
        // @ts-ignore - eeeeeh its right but complicated? TODO?
        const r: InternalRoute = Object.assign(route, {method: 'POST'});
        this._routes.push(r);
        this._methodsInUse.add("POST");

        d(`added a new route for POST ${route.path}`);
    }

    async incoming(req: IncomingMessage, res: ServerResponse, next: () => void) {
        d(`got an incoming request for ${req.method} ${req.url}`);
        // Ensure method is valid
        if (req.method === undefined || !this._methodsInUse.has(req.method)) {
            d(`method was not specified or the method was unknown: ${req.method}`);
            next();
            return;
        }

        if (req.url === undefined) {
            d(`url was not specified ${req.url}`);
            next();
            return;
        }

        const urlInit = req.url;

        const {pathname, searchParams} = new URL(urlInit, `http://${req.headers.host}`);

        // Then locate matching record
        const route = this._routes.find((route) =>
            route.method === req.method
            && (typeof (route.path) === 'string' ? route.path === pathname : route.path.test(pathname))
        );

        d(`identified route: ${route?.path}`)

        if (route === undefined) {
            d('no route was identified');
            next();
            return;
        }

        if (route.method === 'GET') {
            await MicroRouter.incomingGet(pathname, route as GetRoute, searchParams, req, res);
        } else if (route.method === 'POST') {
            await MicroRouter.incomingPost(pathname, route as PostRoute, searchParams, req, res);
        }
    }

    private static close(res: ServerResponse, status: number, message: string) {
        res.statusCode = status;
        res.write(message);
        res.end();
    }

    private static async incomingGet(pathname: string, route: GetRoute, query: URLSearchParams, req: IncomingMessage, res: ServerResponse) {
        if (route.parseQuery) {
            for (let keyBasedValidator of route.queryValidator) {
                const entry = query.get(keyBasedValidator.name);
                if (entry === undefined || entry === null) {
                    if (keyBasedValidator.required) {
                        (route.fail ?? MicroRouter.close)(
                            res,
                            constants.HTTP_STATUS_BAD_REQUEST,
                            `query parameter ${keyBasedValidator.name} is required`,
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

        route.handle(pathname, query, res, req);
    }

    private static async incomingPost(pathname: string, route: PostRoute, query: URLSearchParams, req: IncomingMessage, res: ServerResponse) {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (d) => body += d);
        req.on('close', async () => {
            if (route.parseBody === 'text') {
                if (!await route.validator(body)) {
                    (route.fail ?? MicroRouter.close)(
                        res,
                        constants.HTTP_STATUS_BAD_REQUEST,
                        'invalid body',
                    );
                    return;
                }
            } else if (route.parseBody === 'json') {
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
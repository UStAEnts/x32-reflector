import MicroRouter, {fail, succeed} from "../micro-router";
import {IncomingMessage, ServerResponse} from "http";
import {State} from "../state/state";

const IP_REGEX = /^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)(\.(?!$)|$)){4}$/;

function handle(
    state: State,
    req: IncomingMessage,
    res: ServerResponse,
    ip: string,
    port: number,
    device: string,
) {
    try {
        state.redirect(
            device,
            ip,
            port,
        );

        succeed(res);
    } catch (e: any) {
        fail(res, e.message);
    }
}

export default function (state: State, router: MicroRouter) {
    router.get({
        path: /^\/register$/i,
        parseQuery: true,
        queryValidator: [
            {name: 'ip', required: true, error: 'IP must be a valid IP address', validator: (t) => IP_REGEX.test(t)},
            {name: 'port', required: true, error: 'Port must be a number', validator: (t) => !isNaN(Number(t))},
            {name: 'device', required: true, error: 'Device name require', validator: (t) => /^[A-Za-z]+$/.test(t)},
        ],
        fail: (res, code, error) => fail(res, error),
        handle: ((path, query, res, req) => {
            handle(
                state,
                req,
                res,
                query.get('ip') as string,
                Number(query.get('port')),
                query.get('device') as string,
            );
        }),
    });
}
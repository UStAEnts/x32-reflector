import MicroRouter, {fail, succeed} from "../micro-router";
import {IncomingMessage, ServerResponse} from "http";
import {State} from "../state/state";
import {constants} from "http2";
import {TEMPLATE, X32Instance} from "../config/configuration";

function makeTable(state: State, device: X32Instance) {
    const clients = state.clients(device.name);
    const timeout = state.configuration.timeout * 60000;
    const tableRows = clients.map(({ip, port, checkin}) => `
        <tr>
            <td>${ip}</td>
            <td>${port}</td>
            <td>
                <a href="/remove?ip=${encodeURIComponent(ip)}&port=${encodeURIComponent(port)}&device=${encodeURIComponent(device.name)}">Delete</a>
            </td>
            <td>
                ${(timeout - (Date.now() - checkin)) / 1000}
            </td>
            <td>
                <a href="/renew?ip=${encodeURIComponent(ip)}&port=${encodeURIComponent(port)}&device=${encodeURIComponent(device.name)}">Renew</a>
            </td>
        </tr>`).join('');

    return `<h3>Instance ${device.name} (${device.ip}:${device.port})</h3>
            <table>
                <tr>
                    <th>IP Address</th>
                    <th>Port</th>
                    <th></th>
                    <th>Time Remaining (s)</th>
                    <th></th>
                </tr>
                ${tableRows}
            </table>`;
}

function handle(
    state: State,
    req: IncomingMessage,
    res: ServerResponse,
    error?: string,
) {
    const devices = state.devices.map((device) =>
        `<option value="${device.name}">${device.name} (${device.ip}:${device.port})</option>`
    ).join('');

    const tables = state.devices
        .map((e) => makeTable(state, e))
        .join('<hr/>');

    const template = TEMPLATE
        .replace('{{ERROR_INSERT}}', error ? `<p class="error">${error}</p>` : '')
        .replace('{{DEVICES}}', devices)
        .replace('{{TABLE_INSERT}}', tables);

    res.writeHead(constants.HTTP_STATUS_OK, {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    })
        .write(template)

    res.end();
}


export default function (state: State, router: MicroRouter) {
    router.get({
        path: /^\/?$/i,
        parseQuery: false,
        fail: (res, code, error) => fail(res, error),
        handle: ((path, query, res, req) => {
            handle(
                state,
                req,
                res,
                query.get('error') ?? undefined,
            );
        }),
    });
}
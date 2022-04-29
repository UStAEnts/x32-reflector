import MicroRouter, {fail, succeed} from "../micro-router";
import {IncomingMessage, ServerResponse} from "http";
import {State} from "../state/state";
import {constants} from "http2";
import {TEMPLATE, X32Instance} from "../config/configuration";

const SECONDS = 1000.0;
const MINUTES = 60 * SECONDS;
const HOURS = 60 * MINUTES;

/**
 * Converts a number of milliseconds into the form `n hours, m minutes, s seconds` where if any of the entries are zero
 * it is omitted. This is returned as a simple string. Values are rounded so will always be whole numbers
 * @param millis the number of milliseconds
 * @return the number of milliseconds in a textual format
 */
const millisToTime = (millis: number): string => {
    const hours = Math.floor(millis / HOURS);
    const minutes = Math.floor((millis - (hours * HOURS)) / MINUTES);
    const seconds = Math.floor((millis - ((hours * HOURS) + (minutes * MINUTES))) / SECONDS);

    let result = '';
    if (hours > 0) result += `, ${hours} hours`;
    if (minutes > 0) result += `, ${minutes} minutes`;
    if (seconds > 0) result += `, ${seconds} seconds`;

    if (result.length > 0) return result.substring(2);
    else return 'now';
}

/**
 * Produces a HTML table for the given device listing every forwarding device including its IP, port and remaining time.
 * This also wraps it in a header for the instance.
 * @param state the state from which information of routing can be loaded
 * @param device the device which should be displayed in this table
 * @return a html string containing a header and a table of all devices
 */
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
                ${millisToTime((timeout - (Date.now() - checkin)))}
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
    // Create the set of devices which will be included in the 'register this device' dropdown
    const devices = state.devices.map((device) =>
        `<option value="${device.name}">${device.name} (${device.ip}:${device.port})</option>`
    ).join('');

    // Build the tables and divide them up with a <hr/>
    const tables = state.devices
        .map((e) => makeTable(state, e))
        .join('<hr/>');

    // Replace the regions in the template required which should produce a complete HTML output
    const template = TEMPLATE
        .replace('{{ERROR_INSERT}}', error ? `<p class="error">${error}</p>` : '')
        .replace('{{DEVICES}}', devices)
        .replace('{{TABLE_INSERT}}', tables);

    // And return it, forcing the page to not cache it if possible
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
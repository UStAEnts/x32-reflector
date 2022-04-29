import os from "os";
import path from "path";
import * as zod from "zod";
import {Socket} from "dgram";
import {promises as fsp} from "fs";
import fs from "fs";

/**
 * HTML main site template loaded from file. Content is cached so program will have to be restarted to pick up new
 * changes in the file
 */
export const TEMPLATE = fs.readFileSync('res/index.html', {encoding: 'utf8'});

/**
 * The valid locations for a configuration on the machine. The linux based path is removed if the platform is not
 * identified as linux
 */
const CONFIG_PATHS: string[] = [
    os.platform() === 'linux' ? '/etc/ents/x32-reflector.json' : undefined,
    os.platform() === 'linux' ? path.join('~', '.x32-reflector.config.json') : undefined,
    path.join(__dirname, '..', '..', 'config', 'config.json'),
].filter((e) => e !== undefined) as string[];

const X32_INSTANCE_VALIDATOR = zod.object({
    name: zod.string(),
    ip: zod.string(),
    port: zod.number(),
});
/**
 * A unique instance of X32 connections
 */
export type X32Instance = zod.infer<typeof X32_INSTANCE_VALIDATOR>;
export type X32InstanceWithSocket = X32Instance & { socket: Socket };
/**
 * The validator for the configuration which contains udp and http bind and listen ports as well as timeouts for pairs
 */
const CONFIG_VALIDATOR = zod.object({
    udp: zod.object({
        bind: zod.string(),
    }),
    http: zod.object({
        bind: zod.string(),
        port: zod.number(),
    }),
    x32: X32_INSTANCE_VALIDATOR.or(zod.array(X32_INSTANCE_VALIDATOR)),
    timeout: zod.number(),
    siteRoot: zod.string().regex(/\/$/, {message: 'Path must end in a /'}).default('/'),
});
export type Configuration = zod.infer<typeof CONFIG_VALIDATOR>;


/**
 * Attempts to load the configuration from disk and return it if one is found as a safely parsed object. If no config
 * can be loaded it will throw an error
 * @param paths custom set of locations to test for configuration files, defaults to {@link CONFIG_PATHS}
 */
export async function loadConfiguration(paths: string[] = CONFIG_PATHS): Promise<Configuration> {
    for (const file of paths) {
        console.log(`[config]: trying to load config from path ${file}`);
        let content;

        // Try and read file from disk
        try {
            content = await fsp.readFile(file, {encoding: 'utf8'});
        } catch (e) {
            console.warn(`[config]: could not load configuration file ${file} due to an error: ${e}`)
            continue;
        }

        // Parse it as JSON and fail it out if its not
        try {
            content = JSON.parse(content);
        } catch (e) {
            console.warn(`[config]: Failed to load the JSON data at path ${file} due to error: ${e}`);
            continue;
        }

        // Try and parse it as a config file and reject if the file was not valid with the zod errors7
        // Try and be as helpful with the output as possible
        let safeParse = CONFIG_VALIDATOR.safeParse(content);
        if (!safeParse.success) {
            const reasons = safeParse.error.message + safeParse.error.errors.map((e) => `${e.message} (@ ${e.path.join('.')}`).join(', ');
            console.warn(`[config]: content in ${file} is not valid: ${reasons}`);
            continue;
        }

        console.log(`[config]: config loaded from ${file}`);
        return safeParse.data;
    }

    throw new Error(`No valid configuration found, scanned: ${CONFIG_PATHS.join(', ')}`);
}
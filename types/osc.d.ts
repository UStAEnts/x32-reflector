declare module 'osc' {
    export function readBundle(dv, option, offsetState);

    type Options = {
        idx: number,
        unpackSingleArgs: boolean,
        metadata: boolean,
    };

    type OffsetState = {
        idx: number,
    };

    export type Message = {
        address: string,
    };

    export type Bundle = {
        timeTag: number,
        packets: Packet[],
    };

    export type Packet = Message | Bundle;

    export function readPacket(dv: Uint8Array, options: Partial<Options>, offsetState?: OffsetState, len?: number);

    export function writePacket(packet: Packet, options?: Options): Uint8Array;
}
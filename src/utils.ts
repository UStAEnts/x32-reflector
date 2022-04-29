/**
 * Returns a callback function handling errors as the first parameter. In the event error is non-null it will log
 * the address it failed to forward to and error which raised the error
 * @param address the address to which this send is being made
 * @param port the port to which this send is being made
 */
export function logSend(address: string, port: number) {
    return (error: Error | null) => {
        if (error) {
            console.error(`Failed to forward to address ${address}:${port}`);
            console.error(error);
            return;
        }
    }
}
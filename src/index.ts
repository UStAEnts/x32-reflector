import {State} from "./state/state";
import MicroRouter from "./micro-router";
import register from "./routes/register";
import {createServer, Server} from "http";
import remove from "./routes/remove";
import renew from "./routes/renew";
import index from "./routes/index";
import {Configuration} from "./config/configuration";

const makeServer = (router: MicroRouter, config: Configuration, timeout: number = 5000): Promise<Server> => {
    return new Promise<Server>((resolve, reject) => {
        const server = createServer((req, res) => {
            void router.incoming(req, res, () => {
                res.statusCode = 404;
                res.end();
            });
        });

        // Force a timeout in case something gos wrong with the listen command
        let resolved = false;
        const timeoutInterval = setTimeout(() => {
            if (resolved) return;
            reject();
        }, timeout);

        // Pass along errors before its resolved which should stem from listen.
        server.once('error', (err) => {
            if (resolved) return;
            clearTimeout(timeoutInterval);
            reject(err);
        })

        // Then listen and resolve when done
        server.listen(config.http.port, config.http.bind, () => {
            resolved = true;
            clearTimeout(timeoutInterval);

            resolve(server);
        });
    });
}

State.makeState()
    .then((state) => {
        state.launch();

        const router = new MicroRouter();
        register(state, router);
        remove(state, router);
        renew(state, router);
        index(state, router);

        makeServer(router, state.configuration)
            .then(() => console.log(`[http]: server has launched successfully on http://${state.configuration.http.bind}:${state.configuration.http.port}/`))
            .catch((err) => console.error(`[http]: server failed to launch due to error`, err));
    })
    .catch((err) => console.error(`[root]: failed to launch due to an error initialising`, err));
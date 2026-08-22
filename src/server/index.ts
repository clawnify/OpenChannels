import { createApp } from "@clawnify/app";
import api from "./routes";

type Env = { Bindings: { DB: D1Database } };

// createApp returns an OpenAPIHono with API discovery already mounted —
// GET /api/openapi.json + GET /llms.txt, generated from your live routes.
// That descriptor is how agents discover this app; never hand-write it.
// db:false — routes read the database per request via getDB(c.env).
const app = createApp<Env>({ title: "OpenChannels", version: "1.0.0", db: false });

app.route("/", api);

export default app;

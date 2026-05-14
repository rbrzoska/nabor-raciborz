import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

export default async function (): Promise<Response> {
  try {
    const store = getStore("nabor");
    const raw = await store.get("raciborz");

    if (!raw) {
      return new Response(
        JSON.stringify({ error: "Brak danych — oczekiwanie na pierwsze scrapowanie (cron co 30 min)" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(raw, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=1800, stale-while-revalidate=3600",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export const config: Config = {
  path: "/api/data",
};

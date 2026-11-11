// KnowYourSpend — what's deployed as "kys-llm-eval" between bench runs. The bench (kys-llm-eval.ts) spends on Mistral
// and web search, so it's only deployed while a run is going.
Deno.serve(() =>
  new Response(JSON.stringify({ error: "The test bench is switched off." }), {
    status: 410,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  }),
);

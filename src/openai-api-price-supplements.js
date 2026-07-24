const SOURCE = {
  name: "openai-official-pricing-supplement",
  url: "https://developers.openai.com/api/docs/pricing",
  retrieved_at: "2026-07-23T00:00:00.000Z",
};

function component(usageComponent, amount, conditions = null) {
  return {
    usage_component: usageComponent,
    unit: "token",
    price: { amount: String(amount), currency: "USD", per: "1000000" },
    ...(conditions ? { conditions } : {}),
  };
}

function contextComponents({ input, cached, output, longInput = null, longCached = null, longOutput = null }) {
  if (longInput === null) {
    return [
      component("input_uncached_tokens", input),
      component("input_cache_read_tokens", cached),
      component("output_text_tokens", output),
    ];
  }
  const short = { max_total_input_tokens: "271999" };
  const long = { min_total_input_tokens: "272000" };
  return [
    component("input_uncached_tokens", input, short),
    component("input_uncached_tokens", longInput, long),
    component("input_cache_read_tokens", cached, short),
    component("input_cache_read_tokens", longCached, long),
    component("output_text_tokens", output, short),
    component("output_text_tokens", longOutput, long),
  ];
}

export const OFFICIAL_OPENAI_PRICE_SUPPLEMENTS = [
  {
    schema_version: "0.1",
    id: "openai:gpt-5.5:official-pricing:2026-07-23",
    provider: "openai",
    model: "gpt-5.5",
    components: contextComponents({ input: 5, cached: 0.5, output: 30, longInput: 10, longCached: 1, longOutput: 45 }),
    source: SOURCE,
  },
  {
    schema_version: "0.1",
    id: "openai:gpt-5.4:official-pricing:2026-07-23",
    provider: "openai",
    model: "gpt-5.4",
    components: contextComponents({ input: 2.5, cached: 0.25, output: 15, longInput: 5, longCached: 0.5, longOutput: 22.5 }),
    source: SOURCE,
  },
  {
    schema_version: "0.1",
    id: "openai:gpt-5.4-mini:official-pricing:2026-07-23",
    provider: "openai",
    model: "gpt-5.4-mini",
    components: contextComponents({ input: 0.75, cached: 0.075, output: 4.5 }),
    source: SOURCE,
  },
];

export function addOfficialOpenAiPriceSupplements(resolution) {
  const supplementedModels = new Set(OFFICIAL_OPENAI_PRICE_SUPPLEMENTS.map((card) => card.model));
  const retained = resolution.price_cards.filter((card) => !supplementedModels.has(card.model));
  return {
    ...resolution,
    selected_source: `${resolution.selected_source}+openai-official-supplement`,
    price_cards: [...retained, ...OFFICIAL_OPENAI_PRICE_SUPPLEMENTS],
    sources: [
      ...resolution.sources,
      {
        name: SOURCE.name,
        status: "selected",
        url: SOURCE.url,
        retrieved_at: SOURCE.retrieved_at,
        card_count: OFFICIAL_OPENAI_PRICE_SUPPLEMENTS.length,
        selected: true,
      },
    ],
  };
}

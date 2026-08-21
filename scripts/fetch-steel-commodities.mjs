import { writeFile } from "node:fs/promises";

const chapters = ["72", "73"];
const apiBase = "https://www.trade-tariff.service.gov.uk/uk/api";

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "steel-arb-prototype/0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }

  return response.json();
}

function plainDescription(attributes) {
  return String(
    attributes.description_plain ||
      attributes.formatted_description ||
      attributes.description ||
      ""
  )
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchChapterHeadings(chapterCode) {
  const chapter = await getJson(`${apiBase}/chapters/${chapterCode}`);
  const chapterTitle = plainDescription(chapter.data.attributes);

  const seen = new Set();

  return (chapter.included || [])
    .filter((item) => item.type === "heading")
    .map((heading) => {
      const headingCode = heading.attributes.goods_nomenclature_item_id.slice(0, 4);

      return {
        chapter: chapterCode,
        chapterTitle,
        heading: headingCode,
        headingDescription: plainDescription(heading.attributes),
      };
    })
    .filter((heading) => {
      if (seen.has(heading.heading)) {
        return false;
      }

      seen.add(heading.heading);
      return true;
    });
}

async function fetchHeadingCommodities(heading) {
  const payload = await getJson(`${apiBase}/headings/${heading.heading}`);

  return (payload.included || [])
    .filter((item) => item.type === "commodity")
    .filter((item) => item.attributes.declarable === true)
    .map((commodity) => ({
      code: commodity.attributes.goods_nomenclature_item_id,
      suffix: commodity.attributes.producline_suffix,
      description: plainDescription(commodity.attributes),
      chapter: heading.chapter,
      chapterTitle: heading.chapterTitle,
      heading: heading.heading,
      headingDescription: heading.headingDescription,
    }));
}

const headings = (await Promise.all(chapters.map(fetchChapterHeadings))).flat();
const commodities = [];
const seenCommodities = new Set();

for (const heading of headings) {
  const headingCommodities = await fetchHeadingCommodities(heading);
  for (const commodity of headingCommodities) {
    const key = `${commodity.code}-${commodity.suffix}`;

    if (!seenCommodities.has(key)) {
      seenCommodities.add(key);
      commodities.push(commodity);
    }
  }

  console.log(`${heading.heading}: ${headingCommodities.length}`);
}

commodities.sort((a, b) => {
  const codeOrder = a.code.localeCompare(b.code);
  return codeOrder || a.suffix.localeCompare(b.suffix);
});

const generatedAt = new Date().toISOString();
const payload = {
  source: "GOV.UK Trade Tariff API",
  sourceUrl: "https://www.trade-tariff.service.gov.uk/uk/api",
  generatedAt,
  chapters,
  count: commodities.length,
  commodities,
};

await writeFile(
  "steel-commodities.js",
  `window.STEEL_COMMODITIES = ${JSON.stringify(payload, null, 2)};\n`
);

console.log(`Wrote ${commodities.length} declarable steel commodity records.`);

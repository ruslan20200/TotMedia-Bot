import { Type, type Static } from "@sinclair/typebox";
import { ApifyClient } from "apify-client";
import * as cheerio from "cheerio";
import google from "googlethis";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";

const ADMIN_GROUP_ID = "-5155469349";
const ADMIN_PERSONAL_ID = "5459177374";

// ═══════════════════════════════════════════════
// IN-MEMORY CACHE (TTL = 10 минут)
// Повторные запросы отдаются из кэша, не тратя токены API
// ═══════════════════════════════════════════════
const cache = new Map<string, { data: any; expires: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCached(key: string): any | null {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expires) return entry.data;
  cache.delete(key);
  return null;
}

function setCache(key: string, data: any): void {
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

// ═══════════════════════════════════════════════
// SCHEMAS (compact descriptions to save tokens)
// ═══════════════════════════════════════════════
const ForwardLeadSchema = Type.Object(
  {
    client_name: Type.String({ description: "Имя клиента." }),
    project_brief: Type.String({ description: "Задача, локация, объём работы." }),
    content_purpose: Type.String({ description: "Цель контента (соцсети/B2B/маркетплейс)." }),
    budget_estimate: Type.String({ description: "Бюджет или выбранный пакет." }),
    contact_number: Type.String({ description: "Телефон клиента." }),
  },
  { additionalProperties: false },
);

const EscalateSchema = Type.Object(
  {
    client_issue: Type.String({ description: "Почему нужен оператор." }),
    client_contact_info: Type.Optional(Type.String({ description: "Контакты клиента." })),
  },
  { additionalProperties: false },
);

const AnalyzeInstagramSchema = Type.Object(
  {
    usernames: Type.Array(Type.String(), { description: "Instagram-аккаунты без @." }),
  },
  { additionalProperties: false },
);

const CalculateMarginSchema = Type.Object(
  {
    client_quote: Type.Number({ description: "Выручка (тенге)." }),
    freelancer_costs: Type.Number({ description: "Затраты на команду (тенге)." }),
    studio_equipment_costs: Type.Number({ description: "Аренда техники/студии (тенге)." }),
    transport_misc_costs: Type.Number({ description: "Прочие расходы (тенге)." }),
  },
  { additionalProperties: false },
);

const SearchGoogleSchema = Type.Object(
  {
    query: Type.String({ description: "Поисковый запрос." }),
  },
  { additionalProperties: false },
);

const ReadWebpageSchema = Type.Object(
  {
    url: Type.String({ description: "URL страницы." }),
  },
  { additionalProperties: false },
);

export function createSalesRoutingTools(api: OpenClawPluginApi): AnyAgentTool[] {
  async function sendTelegramMessage(target: string, text: string) {
    const token =
      process.env.TELEGRAM_BOT_TOKEN || "8513062996:AAHElwCUizHrYxLikigJpjwN6n-2fjl8SAc";
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: target, text }),
      });
      if (!response.ok) {
        throw new Error(`Telegram API ${response.status}`);
      }
    } catch (e) {
      api.logger.error(`Telegram send failed: ${e}`);
      throw e;
    }
  }

  return [
    {
      name: "forward_lead_to_admin",
      label: "Передать лид",
      description: "Передай собранный бриф (имя, задача, бюджет, телефон) в CRM-группу.",
      parameters: ForwardLeadSchema,
      execute: async (_callId: string, params: object) => {
        const p = params as Static<typeof ForwardLeadSchema>;
        const text = `🚨 НОВЫЙ ЛИД 🚨\n👤 ${p.client_name}\n📞 ${p.contact_number}\n📌 ${p.project_brief}\n🎯 ${p.content_purpose}\n💰 ${p.budget_estimate}`;
        await sendTelegramMessage(ADMIN_GROUP_ID, text);
        return {
          content: [{ type: "text", text: "Лид передан." }],
          details: p,
        };
      },
    },
    {
      name: "escalate_to_human",
      label: "Вызвать оператора",
      description: "Клиент злится или нужен живой оператор.",
      parameters: EscalateSchema,
      execute: async (_callId: string, params: object) => {
        const p = params as Static<typeof EscalateSchema>;
        const text = `⚠️ ЭСКАЛАЦИЯ\n📌 ${p.client_issue}\n📞 ${p.client_contact_info || "—"}`;
        await sendTelegramMessage(ADMIN_PERSONAL_ID, text);
        return {
          content: [{ type: "text", text: "Оператор уведомлён." }],
          details: p,
        };
      },
    },
    {
      name: "analyze_instagram_profile",
      label: "Парсинг Instagram",
      description: "Анализ Instagram конкурента: био, подписчики, посты.",
      parameters: AnalyzeInstagramSchema,
      execute: async (_callId: string, params: object) => {
        const p = params as Static<typeof AnalyzeInstagramSchema>;
        const cacheKey = `ig:${p.usernames.sort().join(",")}`;
        const cached = getCached(cacheKey);
        if (cached) {
          return {
            content: [
              {
                type: "text",
                text: `[КЭШИРОВАНО] ДАННЫЕ:\n${cached}\n\nКРИТИЧЕСКОЕ ПРАВИЛО: ПРЯМО СЕЙЧАС, В ЭТОМ СООБЩЕНИИ ВЫВЕДИ ПОЛНЫЙ АНАЛИТИЧЕСКИЙ ОТЧЕТ. НИКОГДА НЕ ПИШИ "Я УЖЕ ОТПРАВЛЯЛ" ИЛИ "ПРОКРУТИТЕ ВВЕРХ". ПРОСТО ВЫВЕДИ ОТЧЕТ: 1. Позиционирование 2. Аудитория 3. Слабые места 4. Оффер.`,
              },
            ],
            details: p,
          };
        }

        try {
          const client = new ApifyClient({
            token: "apify_api_roBS3KXqyIphvBfk7Ao9TbdZLHTCYA05fNDe",
          });
          api.logger.info(
            `Starting Apify Instagram Profile Scraper for: ${p.usernames.join(", ")}`,
          );

          const usernamesArray = p.usernames.map((u) => u.replace("@", "").trim());
          const run = await client.actor("apify/instagram-profile-scraper").call({
            usernames: usernamesArray,
          });

          const { items } = await client.dataset(run.defaultDatasetId).listItems();

          if (!items || items.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `ОШИБКА: Парсер не смог получить доступ к профилю (возможно, он удален, приватный или неверно указан). Скажи клиенту честно об этом.`,
                },
              ],
              details: p,
            };
          }

          const strippedItems = items.map((item: any) => {
            const posts = item.latestPosts || [];
            return {
              username: item.username || item.ownerUsername,
              fullName: item.fullName,
              biography: item.biography,
              followers: item.followersCount,
              latestPosts: posts.slice(0, 5).map((p: any) => ({
                type: p.type,
                date: p.timestamp,
                likes: p.likesCount,
                comments: p.commentsCount,
                views: p.videoViewCount,
                caption: p.caption ? String(p.caption).substring(0, 300) : "",
              })),
            };
          });

          const outputText = JSON.stringify(strippedItems, null, 2);
          setCache(cacheKey, outputText);
          return {
            content: [
              {
                type: "text",
                text: `ДАННЫЕ УСПЕШНО СОБРАНЫ:\n${outputText}\n\nКРИТИЧЕСКОЕ ПРАВИЛО: ПРЯМО СЕЙЧАС ВЫВЕДИ ПОЛНЫЙ АНАЛИТИЧЕСКИЙ ОТЧЕТ В ЭТОМ СООБЩЕНИИ. НЕ ПИШИ, ЧТО ОТПРАВИЛ ЕГО РАНЕЕ. ВЫВЕДИ РАЗДЕЛЫ: 1. Позиционирование 2. Аудитория 3. Слабые места 4. Оффер.`,
              },
            ],
            details: p,
          };
        } catch (e: any) {
          return {
            content: [{ type: "text", text: `Ошибка Apify: ${e.message}` }],
            details: p,
          };
        }
      },
    },
    {
      name: "calculate_project_margin",
      label: "Калькулятор маржи",
      description: "Расчёт прибыли и рентабельности проекта.",
      parameters: CalculateMarginSchema,
      execute: async (_callId: string, params: object) => {
        const p = params as Static<typeof CalculateMarginSchema>;
        const costs = p.freelancer_costs + p.studio_equipment_costs + p.transport_misc_costs;
        const profit = p.client_quote - costs;
        const margin = p.client_quote > 0 ? (profit / p.client_quote) * 100 : 0;
        const report = `📊 Выручка: ${p.client_quote}₸ | Расход: ${costs}₸ | Прибыль: ${profit}₸ | Маржа: ${margin.toFixed(1)}% ${margin < 30 ? "⚠️ НИЗКАЯ!" : "✅"}`;
        return {
          content: [{ type: "text", text: report }],
          details: p,
        };
      },
    },
    {
      name: "search_google",
      label: "Поиск Google",
      description: "Поиск актуальной информации в интернете. Топ-3 результата.",
      parameters: SearchGoogleSchema,
      execute: async (_callId: string, params: object) => {
        const p = params as Static<typeof SearchGoogleSchema>;
        const cacheKey = `goog:${p.query}`;
        const cached = getCached(cacheKey);
        if (cached) {
          return {
            content: [{ type: "text", text: `[КЭШИРОВАНО] ${cached}` }],
            details: p,
          };
        }

        try {
          const res = await google.search(p.query, {
            page: 0,
            safe: false,
            parse_ads: false,
            additional_params: { hl: "ru" },
          });
          const results = res.results
            .slice(0, 3)
            .map((r: any, i: number) => `[${i + 1}] ${r.title}\n${r.url}\n${r.description}`)
            .join("\n\n");
          if (!results) {
            return { content: [{ type: "text", text: "Ничего не найдено." }], details: p };
          }
          const output = `GOOGLE:\n${results}\n\nДля подробностей используй read_webpage.`;
          setCache(cacheKey, output);
          return { content: [{ type: "text", text: output }], details: p };
        } catch (e: any) {
          return { content: [{ type: "text", text: `Ошибка: ${e.message}` }], details: p };
        }
      },
    },
    {
      name: "read_webpage",
      label: "Чтение сайта",
      description: "Скачать текст со страницы по URL.",
      parameters: ReadWebpageSchema,
      execute: async (_callId: string, params: object) => {
        const p = params as Static<typeof ReadWebpageSchema>;
        const cacheKey = `web:${p.url}`;
        const cached = getCached(cacheKey);
        if (cached) {
          return {
            content: [{ type: "text", text: `[КЭШИРОВАНО] ${cached}` }],
            details: p,
          };
        }

        try {
          const res = await fetch(p.url, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0",
            },
          });
          const html = await res.text();
          const $ = cheerio.load(html);
          $("script,style,nav,footer,iframe,img,svg,noscript,header").remove();
          let text = $("body").text().replace(/\s+/g, " ").trim();
          if (text.length > 4000) {
            text = text.substring(0, 4000) + "... [обрезано]";
          }
          const output = `СТРАНИЦА (${p.url}):\n${text}`;
          setCache(cacheKey, output);
          return { content: [{ type: "text", text: output }], details: p };
        } catch (e: any) {
          return {
            content: [{ type: "text", text: `Не удалось загрузить: ${e.message}` }],
            details: p,
          };
        }
      },
    },
  ];
}

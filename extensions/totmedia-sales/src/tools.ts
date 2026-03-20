import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { ApifyClient } from "apify-client";
import * as cheerio from "cheerio";
import google from "googlethis";

const ADMIN_GROUP_ID = "-5155469349";
const ADMIN_PERSONAL_ID = "5459177374";

const ForwardLeadSchema = Type.Object(
  {
    client_name: Type.String({ description: "Имя клиента, если известно." }),
    project_brief: Type.String({ description: "Подробное описание задачи, локации, референсов и объема работы." }),
    content_purpose: Type.String({ description: "Цель контента (Для маркетплейса, для соцсетей, для B2B/CRM и т.д.)." }),
    budget_estimate: Type.String({ description: "Ориентировочный бюджет или выбранный пакет из прайс-листа." }),
    contact_number: Type.String({ description: "Подтвержденный номер телефона клиента для связи." }),
  },
  { additionalProperties: false }
);

const EscalateSchema = Type.Object(
  {
    client_issue: Type.String({ description: "Описание проблемы клиента или почему требуется оператор." }),
    client_contact_info: Type.Optional(Type.String({ description: "Контакты клиента, если известны." })),
  },
  { additionalProperties: false }
);

const AnalyzeInstagramSchema = Type.Object(
  {
    usernames: Type.Array(Type.String(), { description: "Список имен пользователей Instagram (аккаунтов франшиз или конкурентов) без @." }),
  },
  { additionalProperties: false }
);

const CalculateMarginSchema = Type.Object(
  {
    client_quote: Type.Number({ description: "Общая сумма, озвученная клиенту (выручка в тенге)." }),
    freelancer_costs: Type.Number({ description: "Затраты на команду: операторы, монтажеры, фотографы (в тенге)." }),
    studio_equipment_costs: Type.Number({ description: "Затраты на аренду техники, студии, реквизита (в тенге)." }),
    transport_misc_costs: Type.Number({ description: "Прочие расходы: транспорт, питание на площадке и т.д. (в тенге)." }),
  },
  { additionalProperties: false }
);

const SearchGoogleSchema = Type.Object(
  {
    query: Type.String({ description: "Поисковый запрос для Google." }),
  },
  { additionalProperties: false }
);

const ReadWebpageSchema = Type.Object(
  {
    url: Type.String({ description: "URL адрес страницы, которую нужно прочитать." }),
  },
  { additionalProperties: false }
);

export function createSalesRoutingTools(api: OpenClawPluginApi): AnyAgentTool[] {
  async function sendTelegramMessage(target: string, text: string) {
    const token = process.env.TELEGRAM_BOT_TOKEN || "8513062996:AAHElwCUizHrYxLikigJpjwN6n-2fjl8SAc";
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: target, text: text })
      });
      if (!response.ok) {
        throw new Error(`Telegram API error ${response.status}: ${await response.text()}`);
      }
      api.logger.info(`Successfully routed message to Telegram ${target}`);
    } catch (e) {
      api.logger.error(`Failed to route message natively: ${e}`);
      throw new Error(`Failed to send message: ${e}`);
    }
  }

  return [
    {
      name: "forward_lead_to_admin",
      label: "Отправить заказ администратору",
      description: "Вызывай этот инструмент ТОЛЬКО когда собрал полный бриф (суть, цель, бюджет) и клиент подтвердил номер телефона. Передает детали лида в основную группу (CRM).",
      parameters: ForwardLeadSchema,
      execute: async (_callId: string, params: object) => {
        const payload = params as Static<typeof ForwardLeadSchema>;
        const text = `🚨 НОВЫЙ ЛИД (ДЕТАЛЬНЫЙ БРИФ) 🚨

👤 Клиент: ${payload.client_name}
📞 Телефон: ${payload.contact_number}

📌 Задача:
${payload.project_brief}
🎯 Цель контента: ${payload.content_purpose}
💰 Бюджет / Пакет: ${payload.budget_estimate}

🤖 Лид передан ассистентом Алимжаном (OpenClaw). Свяжитесь с клиентом!`;
        await sendTelegramMessage(ADMIN_GROUP_ID, text);
        return {
          content: [{ type: "text", text: "Successfully forwarded the detailed lead to the admin group." }],
          details: payload,
        };
      },
    },
    {
      name: "escalate_to_human",
      label: "Передать диалог оператору",
      description: "Вызывай этот инструмент, когда клиент злится, просит оператора или задает нестандартный вопрос, на который нельзя ответить по базе знаний.",
      parameters: EscalateSchema,
      execute: async (_callId: string, params: object) => {
        const payload = params as Static<typeof EscalateSchema>;
        const text = `⚠️ СЛОЖНЫЙ КЛИЕНТ ⚠️\n\n📌 Причина вызова: ${payload.client_issue}\n📞 Контакты: ${payload.client_contact_info || "Не предоставлены"}\n\n🤖 Бот не справляется и ждет паузы, пожалуйста, подключитесь к диалогу.`;
        await sendTelegramMessage(ADMIN_PERSONAL_ID, text);
        return {
          content: [{ type: "text", text: "Successfully escalated the issue to the human operator." }],
          details: payload,
        };
      },
    },
    {
      name: "analyze_instagram_profile",
      label: "Парсинг профиля Instagram",
      description: "Инструмент для Телеграм-ассистента: анализирует Instagram конкурента или франшизы. Извлекает био, количество подписчиков и тексты последних 5 постов для глубокого анализа.",
      parameters: AnalyzeInstagramSchema,
      execute: async (_callId: string, params: object) => {
        const payload = params as Static<typeof AnalyzeInstagramSchema>;
        try {
          const client = new ApifyClient({
              token: "apify_api_roBS3KXqyIphvBfk7Ao9TbdZLHTCYA05fNDe",
          });
          
          api.logger.info(`Starting Apify Instagram Scraper for: ${payload.usernames.join(", ")}`);
          
          const directUrls = payload.usernames.map(u => `https://www.instagram.com/${u.replace('@', '')}/`);
          const run = await client.actor("apify/instagram-scraper").call({
              directUrls: directUrls,
              resultsType: "details",
              resultsLimit: 5,
          });

          const { items } = await client.dataset(run.defaultDatasetId).listItems();
          
          const strippedItems = items.map((item: any) => ({
             username: item.ownerUsername || item.username,
             fullName: item.ownerFullName || item.fullName,
             biography: item.biography,
             followers: item.followersCount,
             postType: item.type,
             likes: item.likesCount,
             comments: item.commentsCount,
             views: item.videoViewCount,
             caption: item.caption ? String(item.caption).substring(0, 300) : "",
          }));

          const outputText = JSON.stringify(strippedItems, null, 2);

          return {
            content: [{ type: "text", text: `РЕЗУЛЬТАТ ПАРСИНГА INSTAGRAM:\n${outputText}\n\nСделай детальный аналитический отчет на основе этих данных.` }],
            details: payload,
          };
        } catch (e: any) {
          api.logger.error(`Apify scraper error: ${e.message}`);
          return {
            content: [{ type: "text", text: `Ошибка парсинга Apify: ${e.message}` }],
            details: payload,
          };
        }
      },
    },
    {
      name: "calculate_project_margin",
      label: "Калькулятор маржинальности проекта",
      description: "Инструмент для вычисления чистой прибыли и рентабельности. Вызывай, когда нужно посчитать смету с учетом всех расходов (аренда, команда, такси).",
      parameters: CalculateMarginSchema,
      execute: async (_callId: string, params: object) => {
        const payload = params as Static<typeof CalculateMarginSchema>;
        const totalCosts = payload.freelancer_costs + payload.studio_equipment_costs + payload.transport_misc_costs;
        const netProfit = payload.client_quote - totalCosts;
        const marginPercentage = payload.client_quote > 0 ? (netProfit / payload.client_quote) * 100 : 0;
        
        const report = `📊 **ФИНАНСОВЫЙ СРЕЗ ПРОЕКТА:**
- Выручка (Чек клиента): ${payload.client_quote.toLocaleString('ru-RU')} ₸
- Роялти / Расход (Себестоимость): ${totalCosts.toLocaleString('ru-RU')} ₸
- **Чистая прибыль: ${netProfit.toLocaleString('ru-RU')} ₸**
- **Маржинальность: ${marginPercentage.toFixed(1)}%**

${marginPercentage < 30 ? '⚠️ ВНИМАНИЕ: Маржинальность ниже 30%. Проект может быть нерентабельным (высокий риск кассового разрыва)!' : '✅ Проект рентабелен. Можно запускать в работу.'}`;

        return {
          content: [{ type: "text", text: report }],
          details: payload,
        };
      },
    },
    {
      name: "search_google",
      label: "Поиск информации в Google",
      description: "Используй этот инструмент для поиска актуальной информации в интернете (новости, цены конкурентов, справочные данные). Возвращает список из топ-5 ссылок с кратким описанием.",
      parameters: SearchGoogleSchema,
      execute: async (_callId: string, params: object) => {
        const payload = params as Static<typeof SearchGoogleSchema>;
        try {
          const options = {
            page: 0, 
            safe: false, 
            parse_ads: false, 
            additional_params: { hl: 'ru' }
          };
          const response = await google.search(payload.query, options);
          const results = response.results.slice(0, 5).map((r: any, idx: number) => 
            `\n[${idx + 1}] ${r.title}\nURL: ${r.url}\nОписание: ${r.description}\n`
          ).join("");
          
          if (!results) return { content: [{ type: "text", text: "Ничего не найдено по этому запросу." }], details: payload };
          
          return {
            content: [{ type: "text", text: `РЕЗУЛЬТАТЫ ПОИСКА GOOGLE:\n${results}\n\nЕсли тебе нужна подробная информация с конкретного сайта, используй инструмент read_webpage, передав ему URL.` }],
            details: payload,
          };
        } catch (e: any) {
          api.logger.error(`Google search failed: ${e.message}`);
          return { content: [{ type: "text", text: `Ошибка поиска: ${e.message}` }], details: payload };
        }
      },
    },
    {
      name: "read_webpage",
      label: "Прочитать содержимое сайта",
      description: "Используй инструмент, чтобы выкачать весь текст с указанного адреса сайта. Полезно для анализа цен конкурентов или чтения полных статей по ссылкам из Google.",
      parameters: ReadWebpageSchema,
      execute: async (_callId: string, params: object) => {
        const payload = params as Static<typeof ReadWebpageSchema>;
        try {
          const response = await fetch(payload.url, { 
            headers: { 
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
            } 
          });
          const html = await response.text();
          const $ = cheerio.load(html);
          
          // Удаляем мусор
          $('script, style, nav, footer, iframe, img, svg, noscript, header').remove();
          
          let text = $('body').text().replace(/\s+/g, ' ').trim();
          if (text.length > 8000) {
              text = text.substring(0, 8000) + "... [Текст обрезан из-за лимита]";
          }
          
          return {
            content: [{ type: "text", text: `ТЕКСТ СТРАНИЦЫ (URL: ${payload.url}):\n\n${text}` }],
            details: payload,
          };
        } catch (e: any) {
          api.logger.error(`Read webpage failed: ${e.message}`);
          return { content: [{ type: "text", text: `Не удалось загрузить сайт (Возможно, стоит защита от парсинга): ${e.message}` }], details: payload };
        }
      },
    }
  ];
}

import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as outputStream } from "node:process";

const task = JSON.parse(process.argv[2] || "{}");

const taskId = task.task_id || `TB_TEST_${Date.now()}`;
const keyword = task.keyword || "";
const minGoodRate = Number(task.min_good_rate ?? 90);
const targetCount = Math.min(Number(task.target_count ?? 1), 3);
const maxScan = Math.min(Number(task.max_scan ?? 10), 30);
const action = task.action || "add_to_cart";

const userDataDir = path.join(
  os.homedir(),
  ".openclaw/browser-profiles/taobao-playwright"
);

const artifactDir = path.join(
  os.homedir(),
  ".openclaw/workspace/skills/taobao-shopping-test/artifacts"
);

fs.mkdirSync(artifactDir, { recursive: true });

function printJson(status, extra = {}) {
  console.log(
    JSON.stringify(
      {
        task_id: taskId,
        keyword,
        min_good_rate: minGoodRate,
        target_count: targetCount,
        action,
        status,
        ...extra
      },
      null,
      2
    )
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCanonicalItemUrl(productId, fallbackUrl = "") {
  const id = String(productId || "").trim();

  if (/^\d{8,}$/.test(id)) {
    return `https://item.taobao.com/item.htm?id=${id}`;
  }

  return fallbackUrl;
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function parseGoodRate(text) {
  if (!text) return null;

  const patterns = [
    /好评率[:：\s]*([0-9]+(?:\.[0-9]+)?)\s*%/i,
    /([0-9]+(?:\.[0-9]+)?)\s*%\s*好评/i,
    /好评[:：\s]*([0-9]+(?:\.[0-9]+)?)\s*%/i,
    /满意度[:：\s]*([0-9]+(?:\.[0-9]+)?)\s*%/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }

  return null;
}
function getKeywordCore(keyword) {
  const raw = String(keyword || "").trim();

  const cleaned = raw
    .replace(/\s+/g, "")
    .replace(/淘宝|天猫|京东|正品|官方|旗舰|旗舰店|包邮|新款|推荐/g, "")
    .replace(/有线|无线|蓝牙|智能|专业|学生|成人|男女|男士|女士/g, "");

  if (cleaned.length >= 2) return cleaned;

  return raw;
}

function isKeywordRelatedText(text, keyword, keywordCore) {
  const t = normalizeText(text);
  const k = String(keyword || "").trim();
  const c = String(keywordCore || "").trim();

  if (!k && !c) return true;

  if (k && t.includes(k)) return true;

  if (c && c.length >= 2 && t.includes(c)) return true;

  return false;
}

function getProductIdFromUrl(url) {
  try {
    const u = new URL(url);
    return (
      u.searchParams.get("id") ||
      u.searchParams.get("itemId") ||
      u.searchParams.get("item_id") ||
      url
    );
  } catch {
    return url;
  }
}
function isRiskOrVerifyText(text) {
  const t = normalizeText(text);

  return /Sorry,\s*we\s*have\s*detected\s*unusual\s*traffic|Please\s*slide\s*to\s*verify|detected unusual traffic|slide to verify|异常流量|滑动验证|请滑动|验证码|安全验证|风险验证|异常访问|访问受限|请完成验证|账号存在风险|环境异常|人机验证|拖动滑块|按住滑块|验证通过/i.test(
    t
  );
}

function isLoginRequiredText(text) {
  const t = normalizeText(text);

  const maybeLogin =
    /亲，请登录|请登录|登录淘宝|扫码登录|账号登录|手机号登录|密码登录|免费注册|登录后查看/i.test(
      t
    );

  const alreadyLoggedIn =
    /我的淘宝|购物车|收藏夹|已买到的宝贝|账号中心|退出登录/i.test(t);

  return maybeLogin && !alreadyLoggedIn;
}

async function getBodyText(page) {
  try {
    return await page.locator("body").innerText({ timeout: 10000 });
  } catch {
    return "";
  }
}

async function screenshot(page, name) {
  const file = path.join(artifactDir, `${taskId}_${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return null;
  }
}

async function askEnter(message) {
  const rl = readline.createInterface({
    input,
    output: outputStream
  });

  await rl.question(message);
  rl.close();
}

/**
 * 人工接管函数：
 * 只要页面仍然是登录页、验证码页、滑块页、异常流量页，就一直等待人工处理。
 * 不会直接返回失败。
 */
async function waitUntilPageUsable(page, stageName) {
  while (true) {
    await page.waitForTimeout(2000);

    const text = await getBodyText(page);
    const currentUrl = page.url();

    if (isRiskOrVerifyText(text)) {
      const shot = await screenshot(page, `${stageName}_risk_or_verify`);

      console.log("\n====================================================");
      console.log("检测到淘宝验证码 / 滑块验证 / 异常流量检测。");
      console.log("脚本不会自动绕过验证。");
      console.log("请你在打开的浏览器窗口中手动完成验证。");
      console.log(`当前页面：${currentUrl}`);
      if (shot) console.log(`截图已保存：${shot}`);
      console.log("完成验证后，回到当前终端按 Enter。");
      console.log("如果按 Enter 后页面仍然是验证页，脚本会继续等待。");
      console.log("====================================================\n");

      await askEnter("人工验证完成后按 Enter 继续检测：");

      await page.waitForTimeout(3000);
      continue;
    }

    if (isLoginRequiredText(text)) {
      const shot = await screenshot(page, `${stageName}_login_required`);

      console.log("\n====================================================");
      console.log("检测到淘宝当前未登录或登录态失效。");
      console.log("脚本不会接收或输入淘宝账号密码。");
      console.log("请你在打开的浏览器窗口中手动完成淘宝登录。");
      console.log(`当前页面：${currentUrl}`);
      if (shot) console.log(`截图已保存：${shot}`);
      console.log("登录完成后，回到当前终端按 Enter。");
      console.log("如果按 Enter 后仍未登录，脚本会继续等待。");
      console.log("====================================================\n");

      await askEnter("人工登录完成后按 Enter 继续检测：");

      await page.waitForTimeout(3000);
      continue;
    }

    return true;
  }
}

async function closeExtraPages(context, keepPage) {
  for (const p of context.pages()) {
    if (p !== keepPage) {
      await p.close().catch(() => {});
    }
  }
}

async function openTaobaoHome(page) {
  await page.goto("https://www.taobao.com", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await waitUntilPageUsable(page, "home");
}

async function searchKeyword(page, keyword) {
  await waitUntilPageUsable(page, "before_search");

  const searchUrl = `https://s.taobao.com/search?q=${encodeURIComponent(keyword)}`;

  console.log(`\n直接打开淘宝搜索结果页：${searchUrl}`);

  await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForTimeout(5000);

  await waitUntilPageUsable(page, "search_result");

  const currentUrl = page.url();
  console.log("搜索后当前页面：", currentUrl);

  /**
   * 如果仍然停留在 www.taobao.com，说明淘宝没有进入搜索结果页。
   */
  if (currentUrl.includes("www.taobao.com") && !currentUrl.includes("s.taobao.com")) {
    console.log("当前仍在淘宝首页，尝试使用页面搜索框兜底搜索。");

    const inputCandidates = [
      'input[name="q"]',
      'input[placeholder*="搜索"]',
      'input[aria-label*="搜索"]',
      'input[type="search"]'
    ];

    let searched = false;

    for (const selector of inputCandidates) {
      const input = page.locator(selector).first();

      if (await input.isVisible().catch(() => false)) {
        await input.click();
        await input.fill(keyword);
        await page.keyboard.press("Enter");

        searched = true;
        break;
      }
    }

    if (!searched) {
      console.log("没有找到可用搜索框。");
      return;
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000);

    await waitUntilPageUsable(page, "search_result_after_fallback");

    console.log("兜底搜索后当前页面：", page.url());
  }

  /**
   * 等待搜索结果卡片出现。
   * 当前淘宝搜索结果常见卡片：
   * a[id^="item_id_"]
   * a[class*="CardV2--doubleCardWrapper"]
   */
  const resultCardSelector = [
    'a[id^="item_id_"]',
    'a[class*="CardV2--doubleCardWrapper"]',
    'a[href*="click.simba.taobao.com"]',
    'a[href*="item.taobao.com"]',
    'a[href*="detail.tmall.com"]'
  ].join(",");

  try {
    await page.locator(resultCardSelector).first().waitFor({
      state: "visible",
      timeout: 20000
    });

    console.log("已检测到淘宝搜索结果商品卡片。");
  } catch {
    const text = await getBodyText(page);
    console.log("没有等到商品卡片，当前页面文本前 500 字：");
    console.log(text.slice(0, 500));
  }
}

async function collectProductLinks(page, keyword) {
  // collectProductLinks_LOCATOR_V3
  await waitUntilPageUsable(page, "collect_links");

  const keywordCore = getKeywordCore(keyword);
  const searchShot = await screenshot(page, "search_result");
  if (page.url().includes("www.taobao.com") && !page.url().includes("s.taobao.com")) {
  console.log("警告：当前仍在淘宝首页，不是搜索结果页。将直接跳转到搜索页。");

  await page.goto(`https://s.taobao.com/search?q=${encodeURIComponent(keyword)}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForTimeout(5000);
  await waitUntilPageUsable(page, "collect_links_redirect_search");
}
  await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  function normalizeUrl(url) {
    if (!url) return "";
    if (url.startsWith("//")) return "https:" + url;
    return url;
  }

  function getProductId(idAttr, href) {
    if (idAttr && idAttr.startsWith("item_id_")) {
      return idAttr.replace("item_id_", "");
    }

    try {
      const u = new URL(href);
      return (
        u.searchParams.get("id") ||
        u.searchParams.get("itemId") ||
        u.searchParams.get("item_id") ||
        u.searchParams.get("auctionId") ||
        u.searchParams.get("ad_id") ||
        href
      );
    } catch {
      return href;
    }
  }

  function isKeywordRelated(text) {
    const t = normalizeText(text);
    const k = normalizeText(keyword);
    const c = normalizeText(keywordCore);

    if (k && t.includes(k)) return true;
    if (c && c.length >= 2 && t.includes(c)) return true;

    return false;
  }

  function pickTitleFromText(text) {
    const t = normalizeText(text);

    const parts = t
      .split(/(?=¥)|(?=￥)|(?=\d+万?\+?人付款)|(?=月销)|(?=官方旗舰店)|(?=旗舰店)|(?=店)/)
      .map((x) => normalizeText(x))
      .filter(Boolean);

    const hit = parts.find((x) => isKeywordRelated(x) && x.length >= 3);

    if (hit) return hit.slice(0, 180);

    return t.slice(0, 180);
  }

  const cardSelector = [
    'a[id^="item_id_"]',
    'a[class*="CardV2--doubleCardWrapper"]',
    'a[href*="click.simba.taobao.com"][id^="item_id_"]',
    'a[href*="click.simba.taobao.com"][class*="CardV2"]'
  ].join(",");

  const cardLocator = page.locator(cardSelector);
  const rawCount = await cardLocator.count().catch(() => 0);

  console.log("\n搜索关键词：", keyword);
  console.log("关键词核心词：", keywordCore);
  console.log("淘宝搜索卡片 locator 数量：", rawCount);

  const links = [];
  const seen = new Set();

  for (let i = 0; i < Math.min(rawCount, 100); i++) {
    const card = cardLocator.nth(i);

    try {
      const hrefRaw = await card.getAttribute("href").catch(() => "");
      const href = normalizeUrl(hrefRaw || "");

      if (!href) continue;

      const idAttr = await card.getAttribute("id").catch(() => "");
      const productId = getProductId(idAttr, href);

      if (seen.has(productId)) continue;

      const cardText = normalizeText(
        await card.innerText({ timeout: 3000 }).catch(() => "")
      );

      if (!cardText) continue;

      let title = "";

      title = normalizeText(
        await card
          .locator('[class*="Title--title"]')
          .first()
          .innerText({ timeout: 1000 })
          .catch(() => "")
      );

      if (!title) {
        title = normalizeText(
          await card
            .locator('[class*="Title--descWrapper"]')
            .first()
            .innerText({ timeout: 1000 })
            .catch(() => "")
        );
      }

      if (!title) {
        title = pickTitleFromText(cardText);
      }

      let price = "";

      const priceWrapperText = normalizeText(
        await card
          .locator('[class*="Price--priceWrapper"]')
          .first()
          .innerText({ timeout: 1000 })
          .catch(() => "")
      );

      if (priceWrapperText) {
        const m = priceWrapperText.match(/[¥￥]\s*\d+(?:\.\d+)?/);
        if (m) price = m[0];
      }

      if (!price) {
        const m = cardText.match(/[¥￥]\s*\d+(?:\.\d+)?/);
        if (m) price = m[0];
      }

      const sales = normalizeText(
        await card
          .locator('[class*="Price--realSales"]')
          .first()
          .innerText({ timeout: 1000 })
          .catch(() => "")
      );

      const shop = normalizeText(
        await card
          .locator('[class*="ShopInfo--shopNameText"]')
          .first()
          .innerText({ timeout: 1000 })
          .catch(() => "")
      );

      const abstractText = normalizeText(
        await card
          .locator('[class*="Abstract"]')
          .first()
          .innerText({ timeout: 1000 })
          .catch(() => "")
      );

      // 关键：按“有线耳机”或核心词“耳机”过滤
      if (!isKeywordRelated(title) && !isKeywordRelated(cardText)) {
        console.log(`跳过不相关卡片：${title || cardText.slice(0, 80)}`);
        continue;
      }

      let score = 0;

      if (normalizeText(title).includes(normalizeText(keyword))) score += 80;
      if (normalizeText(title).includes(normalizeText(keywordCore))) score += 50;
      if (cardText.includes(normalizeText(keyword))) score += 50;
      if (cardText.includes(normalizeText(keywordCore))) score += 30;
      if (price) score += 20;
      if (sales) score += 10;
      if (shop) score += 10;
      if (abstractText.includes("好评")) score += 20;
      if (href.includes("click.simba.taobao.com")) score += 5;

      seen.add(productId);

  const canonicalUrl = buildCanonicalItemUrl(productId, href);

links.push({
  title: title.slice(0, 180),
  url: canonicalUrl,
  source_url: href,
  product_id: productId,
  price,
  sales,
  shop,
  abstract: abstractText,
  card_text: cardText.slice(0, 800),
  score
});
    } catch (err) {
      console.log("解析单个商品卡片失败：", String(err.message || err).slice(0, 200));
    }
  }

  links.sort((a, b) => b.score - a.score);

  console.log("候选商品链接数量：", links.length);

  links.slice(0, 10).forEach((x, i) => {
    console.log(`${i + 1}. score=${x.score}`);
    console.log(`   title=${x.title}`);
    console.log(`   price=${x.price || ""}`);
    console.log(`   sales=${x.sales || ""}`);
    console.log(`   shop=${x.shop || ""}`);
    console.log(`   abstract=${x.abstract || ""}`);
    console.log(`   product_id=${x.product_id}`);
    console.log(`   url=${x.url}`);
  });

  if (links.length === 0) {
    const debugInfo = await page.evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll(
          'a[id^="item_id_"], a[class*="CardV2--doubleCardWrapper"], a[href*="click.simba.taobao.com"]'
        )
      ).slice(0, 20);

      return {
        title: document.title,
        url: location.href,
        bodyText: document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 1500),
        cardCount: cards.length,
        cards: cards.map((a, i) => ({
          i,
          id: a.getAttribute("id"),
          className: a.getAttribute("class"),
          href: a.getAttribute("href"),
          text: (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300)
        }))
      };
    }).catch((err) => ({
      error: String(err.message || err)
    }));

    console.log("\n========== 商品卡片调试信息 ==========");
    console.log(JSON.stringify(debugInfo, null, 2));
    console.log("=====================================\n");
  }

  return {
    links,
    searchShot,
    keywordCore
  };
}
async function parseProductDetail(context, item, index, keyword, keywordCore) {
  const detail = await context.newPage();

  try {
    const targetUrl = buildCanonicalItemUrl(item.product_id, item.url);

    console.log(`打开商品详情页：${targetUrl}`);

    await detail.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000
    });

    await detail.waitForTimeout(4000);

    await waitUntilPageUsable(detail, `detail_${index}`);

    const text = await getBodyText(detail);
    const goodRate = parseGoodRate(text);

    let title = item.title;

    try {
      const possibleTitle = await detail
        .locator("h1, [class*=title], [class*=Title]")
        .first()
        .innerText({ timeout: 5000 });

      if (possibleTitle && possibleTitle.trim().length > 3) {
        title = possibleTitle.trim();
      }
    } catch {
      // 使用搜索结果页标题
    }
    const detailTextForCheck = `${title} ${text.slice(0, 1000)}`;

if (!isKeywordRelatedText(detailTextForCheck, keyword, keywordCore)) {
  return {
    title: title.slice(0, 160),
    price: "",
    shop: "",
    url: item.url,
    good_rate: null,
    rate_found: false,
    keyword_mismatch: true,
    mismatch_reason: `商品详情页内容与搜索关键词不匹配，keyword=${keyword}, core=${keywordCore}`
  };
}
    let price = "";

    const pricePatterns = [
      /¥\s*([0-9]+(?:\.[0-9]+)?)/,
      /￥\s*([0-9]+(?:\.[0-9]+)?)/,
      /价格[:：\s]*([0-9]+(?:\.[0-9]+)?)/
    ];

    for (const pattern of pricePatterns) {
      const match = text.match(pattern);
      if (match) {
        price = match[1];
        break;
      }
    }

    let shop = "";

    const shopPatterns = [
      /店铺[:：\s]*([^\s]{2,30})/,
      /掌柜[:：\s]*([^\s]{2,30})/
    ];

    for (const pattern of shopPatterns) {
      const match = text.match(pattern);
      if (match) {
        shop = match[1];
        break;
      }
    }

    return {
      title: title.slice(0, 160),
      price,
      shop,
      url: item.url,
      good_rate: goodRate,
      rate_found: goodRate !== null
    };
  } finally {
    await detail.close().catch(() => {});
  }
}

async function chooseSkuIfPossible(page) {
  const skuKeywords = /颜色|尺码|规格|套餐|版本|型号|款式|容量|分类/;

  const bodyText = await getBodyText(page);

  if (!skuKeywords.test(bodyText)) {
    return {
      selected: false,
      reason: "NO_SKU_REQUIRED"
    };
  }

  const candidates = page.locator(
    'button:not([disabled]), [role="button"], li:not([disabled]), span:not([disabled]), div:not([disabled])'
  );

  const count = await candidates.count().catch(() => 0);

  for (let i = 0; i < Math.min(count, 120); i++) {
    const item = candidates.nth(i);

    try {
      const visible = await item.isVisible();
      if (!visible) continue;

      const text = normalizeText(await item.innerText({ timeout: 1000 }).catch(() => ""));

      if (!text) continue;
      if (/加入购物车|立即购买|购买|付款|结算|客服|收藏|分享|店铺|首页/.test(text)) {
        continue;
      }

      if (/缺货|无货|售罄|不可选|已选/.test(text)) {
        continue;
      }

      const box = await item.boundingBox();
      if (!box || box.width < 10 || box.height < 10) continue;

      await item.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);

      return {
        selected: true,
        text
      };
    } catch {
      // 继续尝试下一个
    }
  }

  return {
    selected: false,
    reason: "SKU_MAY_BE_REQUIRED_BUT_NOT_SELECTED"
  };
}
async function findAddCartButton(page) {
  const candidateLocators = [
    // 最推荐：直接找 button 中包含“加入购物车”
    page.locator('button').filter({ hasText: /加入购物车/ }),

    // 兼容淘宝这种 button > span 的结构
    page.locator('xpath=//button[.//span[contains(normalize-space(.), "加入购物车")]]'),

    // 兼容 class 里带 primaryBtn / leftBtn 的按钮
    page.locator('button[class*="primaryBtn"]').filter({ hasText: /加入购物车/ }),
    page.locator('button[class*="leftBtn"]').filter({ hasText: /加入购物车/ }),
    page.locator('button[class*="btn"]').filter({ hasText: /加入购物车/ }),

    // 兜底：通过 role 找按钮
    page.getByRole('button', { name: /加入购物车/ })
  ];

  for (const locator of candidateLocators) {
    const count = await locator.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const btn = locator.nth(i);

      const visible = await btn.isVisible().catch(() => false);
      if (!visible) continue;

      const enabled = await btn.isEnabled().catch(() => false);
      if (!enabled) continue;

      const text = await btn.innerText().catch(() => "");

      // 安全检查：必须是加入购物车，不能是购买、结算、付款
      if (!/加入购物车/.test(text)) continue;
      if (/立即购买|马上抢|提交订单|去结算|结算|付款|确认支付|购买|下单/.test(text)) {
        continue;
      }

      return btn;
    }
  }

  return null;
}
async function addProductToCart(context, product, index) {
  const detail = await context.newPage();

  try {
  const targetUrl = buildCanonicalItemUrl(product.product_id, product.url);

        console.log(`准备加购商品，打开详情页：${targetUrl}`);

        await detail.goto(targetUrl, {
        waitUntil: "domcontentloaded",
            timeout: 60000
});

    await detail.waitForTimeout(4000);

    await waitUntilPageUsable(detail, `cart_${index}`);

    const beforeText = await getBodyText(detail);
    const currentUrl = detail.url();

if (
  /我的淘宝|我的订单|已买到的宝贝|收货地址|账户设置|我的购物车有降价/.test(beforeText) &&
  !/加入购物车|立即购买|商品|价格|月销|已售|人付款/.test(beforeText)
) {
  product.cart_status = "WRONG_PAGE_NOT_PRODUCT_DETAIL";
  product.error = "当前页面是我的淘宝/账户页，不是商品详情页，因此无法查找加入购物车按钮";
  product.current_url = currentUrl;
  product.target_url = targetUrl;
  product.screenshot = await screenshot(detail, `cart_${index}_wrong_page`);
  product.debug_text = beforeText.slice(0, 800);
  return product;
}

    const skuResult = await chooseSkuIfPossible(detail);
    product.sku_selection = skuResult;

    await detail.waitForTimeout(1000);

// 等待页面上的按钮区域加载出来
await detail.waitForSelector("button, span", {
  timeout: 20000
}).catch(() => {});

const addCartButton = await findAddCartButton(detail);

if (!addCartButton) {
  product.cart_status = "ADD_CART_BUTTON_NOT_FOUND";
  product.screenshot = await screenshot(detail, `cart_${index}_button_not_found`);

  const pageText = await getBodyText(detail);

  product.error = "页面上未找到可点击的“加入购物车”button";
  product.debug_text = pageText.slice(0, 800);

  return product;
}

await addCartButton.scrollIntoViewIfNeeded().catch(() => {});
await detail.waitForTimeout(500);

await addCartButton.click({
  timeout: 15000
});

    await detail.waitForTimeout(3000);

    await waitUntilPageUsable(detail, `after_add_cart_${index}`);

    const afterText = await getBodyText(detail);

    if (/成功加入购物车|已加入购物车|加入成功|商品已成功加入购物车|添加成功/.test(afterText)) {
      product.cart_status = "SUCCESS";
    } else if (/请选择|选择规格|请选择规格|颜色|尺码|套餐|型号|版本/.test(afterText)) {
      product.cart_status = "SKU_REQUIRED";
    } else if (/库存不足|缺货|售罄|已下架/.test(afterText)) {
      product.cart_status = "OUT_OF_STOCK";
    } else {
      product.cart_status = "ADD_CART_RESULT_UNKNOWN";
    }

    product.screenshot = await screenshot(detail, `cart_${index}_result`);

    return product;
  } finally {
    await detail.close().catch(() => {});
  }
}

async function main() {
  if (!keyword) {
    printJson("INVALID_TASK", {
      error_code: "INVALID_TASK",
      message: "keyword 不能为空"
    });
    return;
  }

  if (action !== "add_to_cart") {
    printJson("INVALID_TASK", {
      error_code: "INVALID_TASK",
      message: "action 只允许 add_to_cart"
    });
    return;
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: "chrome",
    viewport: {
      width: 1400,
      height: 900
    },
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    await closeExtraPages(context, page);

    await openTaobaoHome(page);

    await searchKeyword(page, keyword);

    const { links, searchShot, keywordCore } = await collectProductLinks(page, keyword);

    if (!links.length) {
      printJson("NO_RESULT", {
        error_code: "NO_RESULT",
        message: "没有读取到淘宝商品结果",
        screenshot: searchShot
      });

      await context.close();
      return;
    }

    const scanned = [];
    const matched = [];
    let rateFoundCount = 0;

    for (let i = 0; i < Math.min(maxScan, links.length); i++) {
      const item = links[i];

      console.log(`\n正在检查第 ${i + 1} 个商品：${item.title.slice(0, 60)}...`);

      try {
        const detail = await parseProductDetail(context, item, i + 1, keyword, keywordCore);
        if (detail.page_mismatch) {
            console.log(`跳过异常页面：${detail.mismatch_reason}`);
            continue;
        }
        scanned.push(detail);
        if (detail.keyword_mismatch) {
            console.log(`跳过不相关商品：${detail.title}`);
            continue;
        }
        if (detail.rate_found) {
          rateFoundCount++;
        }

        if (detail.good_rate !== null && detail.good_rate > minGoodRate) {
         matched.push({
            title: detail.title,
            price: detail.price,
            shop: detail.shop,
            url: buildCanonicalItemUrl(detail.product_id, detail.url),
            source_url: detail.source_url,
            product_id: detail.product_id,
            good_rate: detail.good_rate,
            cart_status: "PENDING"
        });

          console.log(`命中商品：好评率 ${detail.good_rate}% > ${minGoodRate}%`);
        } else if (detail.good_rate !== null) {
          console.log(`未命中：好评率 ${detail.good_rate}% 不大于 ${minGoodRate}%`);
        } else {
          console.log("未找到明确好评率，继续检查下一个商品。");
        }

        if (matched.length >= targetCount) {
          break;
        }
      } catch (err) {
        scanned.push({
          title: item.title,
          url: item.url,
          error: String(err.message || err).slice(0, 300)
        });

        console.log(`该商品检查失败，继续下一个：${String(err.message || err).slice(0, 120)}`);
      }
    }

    if (!matched.length) {
      const status = rateFoundCount === 0 ? "RATE_NOT_FOUND" : "NO_MATCHED_PRODUCT";

      printJson(status, {
        error_code: status,
        message:
          rateFoundCount === 0
            ? `扫描前 ${Math.min(maxScan, links.length)} 个商品后，没有找到明确的好评率字段。淘宝页面可能未展示好评率。`
            : `扫描前 ${Math.min(maxScan, links.length)} 个商品后，没有找到好评率大于 ${minGoodRate}% 的商品。`,
        scanned_count: Math.min(maxScan, links.length),
        rate_found_count: rateFoundCount,
        scanned_products: scanned.slice(0, 10),
        screenshot: searchShot
      });

      await context.close();
      return;
    }

    const cartResults = [];

    for (let i = 0; i < matched.length; i++) {
  if (!isKeywordRelatedText(matched[i].title, keyword, keywordCore)) {
    console.log(`跳过标题不相关的命中商品：${matched[i].title}`);
    continue;
  }

  console.log(`\n正在加入购物车：${matched[i].title.slice(0, 60)}...`);

  const result = await addProductToCart(context, matched[i], i + 1);
  cartResults.push(result);
}

    const successCount = cartResults.filter((p) => p.cart_status === "SUCCESS").length;

    const finalStatus =
      successCount === cartResults.length
        ? "SUCCESS"
        : successCount > 0
          ? "PARTIAL_SUCCESS"
          : "ADD_CART_FAILED";

    printJson(finalStatus, {
      matched_count: matched.length,
      cart_success_count: successCount,
      products: cartResults,
      scanned_count: scanned.length,
      screenshot: searchShot
    });

    await context.close();
  } catch (err) {
    const shot = await screenshot(page, "browser_error");

    printJson("BROWSER_ERROR", {
      error_code: "BROWSER_ERROR",
      message: String(err.message || err),
      screenshot: shot
    });

    await context.close().catch(() => {});
  }
}

main();

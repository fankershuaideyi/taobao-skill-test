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

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function parseGoodRate(text) {
  if (!text) return null;

  const t = normalizeText(text);

  const patterns = [
    /好评率[:：\s]*([0-9]+(?:\.[0-9]+)?)\s*%/i,
    /([0-9]+(?:\.[0-9]+)?)\s*%\s*好评/i,
    /好评[:：\s]*([0-9]+(?:\.[0-9]+)?)\s*%/i,
    /满意度[:：\s]*([0-9]+(?:\.[0-9]+)?)\s*%/i
  ];

  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (match) return Number(match[1]);
  }

  return null;
}

/**
 * 保留你原先版本的人机验证识别逻辑。
 */
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
 * 保留你原先版本的人机验证人工接管函数。
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

async function launchContext() {
  try {
    return await chromium.launchPersistentContext(userDataDir, {
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
  } catch {
    return await chromium.launchPersistentContext(userDataDir, {
      headless: false,
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
  }
}

async function openTaobaoHome(page) {
  await page.goto("https://www.taobao.com", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForTimeout(3000);
  await waitUntilPageUsable(page, "home");
}

/**
 * 直接打开淘宝搜索结果页。
 * 不再依赖首页搜索框，避免搜索没有真正跳转。
 */
async function openSearchPage(page) {
  const searchUrl = `https://s.taobao.com/search?q=${encodeURIComponent(keyword)}`;

  console.log(`\n打开淘宝综合搜索页：${searchUrl}`);

  await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForTimeout(5000);
  await waitUntilPageUsable(page, "search_page");

  console.log("搜索页当前 URL：", page.url());
}

/**
 * 淘宝当前搜索结果卡片常见结构：
 * <a id="item_id_xxx" class="CardV2--doubleCardWrapper--xxx" href="https://click.simba.taobao.com/...">
 */
function getSearchCardLocator(page) {
  return page.locator(
    [
      'a[id^="item_id_"]',
      'a[class*="CardV2--doubleCardWrapper"]',
      'a[href*="click.simba.taobao.com"][id^="item_id_"]',
      'a[href*="click.simba.taobao.com"][class*="CardV2"]',
      'a[href*="item.taobao.com"]',
      'a[href*="detail.tmall.com"]'
    ].join(",")
  );
}

async function waitSearchCards(page) {
  const cardLocator = getSearchCardLocator(page);

  for (let i = 0; i < 8; i++) {
    await waitUntilPageUsable(page, `wait_search_cards_${i + 1}`);

    const count = await cardLocator.count().catch(() => 0);

    if (count > 0) {
      console.log(`检测到搜索结果商品卡片数量：${count}`);
      return count;
    }

    console.log(`暂未检测到商品卡片，滚动加载，第 ${i + 1} 次。`);
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(2000);
  }

  return 0;
}

async function getCardBrief(card, index) {
  const text = normalizeText(await card.innerText({ timeout: 3000 }).catch(() => ""));
  const href = await card.getAttribute("href").catch(() => "");
  const id = await card.getAttribute("id").catch(() => "");

  let title = normalizeText(
    await card
      .locator('[class*="Title--title"]')
      .first()
      .innerText({ timeout: 1200 })
      .catch(() => "")
  );

  if (!title) {
    title = normalizeText(
      await card
        .locator('[class*="Title--descWrapper"]')
        .first()
        .innerText({ timeout: 1200 })
        .catch(() => "")
    );
  }

  if (!title) {
    title = text.slice(0, 160);
  }

  let price = "";
  const priceText = normalizeText(
    await card
      .locator('[class*="Price--priceWrapper"]')
      .first()
      .innerText({ timeout: 1200 })
      .catch(() => "")
  );

  const priceMatch = (priceText || text).match(/[¥￥]\s*\d+(?:\.\d+)?/);
  if (priceMatch) price = priceMatch[0];

  const sales = normalizeText(
    await card
      .locator('[class*="Price--realSales"]')
      .first()
      .innerText({ timeout: 1200 })
      .catch(() => "")
  );

  const shop = normalizeText(
    await card
      .locator('[class*="ShopInfo--shopNameText"]')
      .first()
      .innerText({ timeout: 1200 })
      .catch(() => "")
  );

  return {
    index,
    id,
    title,
    price,
    sales,
    shop,
    href,
    card_text: text.slice(0, 600)
  };
}

/**
 * 核心替换部分：
 * 不再 goto click.simba，也不再拼 item.taobao.com。
 * 直接点击搜索结果卡片，等待淘宝自己打开真实商品详情页。
 */
async function openDetailByClick(searchPage, card, index) {
  await waitUntilPageUsable(searchPage, `before_click_card_${index}`);

  await card.scrollIntoViewIfNeeded().catch(() => {});
  await searchPage.waitForTimeout(1000);

  const context = searchPage.context();
  const beforePages = new Set(context.pages());

  const popupPromise = searchPage
    .waitForEvent("popup", { timeout: 15000 })
    .catch(() => null);

  console.log(`点击综合排序第 ${index} 个商品卡片，等待详情页打开。`);

  await card.click({
    timeout: 15000
  });

  let detailPage = await popupPromise;

  if (!detailPage) {
    const afterPages = context.pages();
    const newPage = afterPages.find((p) => !beforePages.has(p));

    if (newPage) {
      detailPage = newPage;
    }
  }

  /**
   * 如果没有新标签页，说明淘宝可能在当前页跳转。
   */
  if (!detailPage) {
    detailPage = searchPage;
  }

  await detailPage.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
  await detailPage.waitForTimeout(5000);
  await waitUntilPageUsable(detailPage, `detail_${index}`);

  console.log(`详情页当前 URL：${detailPage.url()}`);

  return detailPage;
}

function isWrongMyTaobaoPage(text, url) {
  const t = normalizeText(text);
  const u = String(url || "");

  const looksLikeMyTaobao =
    /我的订单|已买到的宝贝|收货地址|账户设置|我的购物车有降价|我的卡券包|退款维权|评价管理/.test(
      t
    ) || /i\.taobao\.com|buyertrade\.taobao\.com/.test(u);

  const looksLikeProduct =
    /加入购物车|立即购买|商品详情|宝贝详情|价格|月销|已售|人付款|评价/.test(t);

  return looksLikeMyTaobao && !looksLikeProduct;
}

async function extractProductTitle(page) {
  const selectors = [
    "h1",
    '[class*="ItemHeader"]',
    '[class*="title"]',
    '[class*="Title"]',
    '[class*="tb-main-title"]'
  ];

  for (const selector of selectors) {
    const text = normalizeText(
      await page.locator(selector).first().innerText({ timeout: 1500 }).catch(() => "")
    );

    if (text && text.length >= 3) return text.slice(0, 200);
  }

  const bodyText = await getBodyText(page);
  return bodyText.slice(0, 160);
}

async function parseGoodRateFromDetail(page) {
  await waitUntilPageUsable(page, "parse_good_rate_initial");

  let text = await getBodyText(page);
  let rate = parseGoodRate(text);

  if (rate !== null) return rate;

  /**
   * 滚动详情页，等待评价区域懒加载。
   */
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 1000);
    await page.waitForTimeout(2000);
    await waitUntilPageUsable(page, `parse_good_rate_scroll_${i + 1}`);

    text = await getBodyText(page);
    rate = parseGoodRate(text);

    if (rate !== null) return rate;
  }

  /**
   * 尝试点击评价相关 Tab。
   */
  const reviewLocators = [
    page.getByText("宝贝评价", { exact: false }).first(),
    page.getByText("累计评价", { exact: false }).first(),
    page.getByText("评价", { exact: false }).first()
  ];

  for (const loc of reviewLocators) {
    const visible = await loc.isVisible().catch(() => false);

    if (!visible) continue;

    await loc.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await waitUntilPageUsable(page, "after_click_review_tab");

    text = await getBodyText(page);
    rate = parseGoodRate(text);

    if (rate !== null) return rate;
  }

  return null;
}

async function findAddCartButton(page) {
  const candidateLocators = [
    page.locator("button").filter({ hasText: /加入购物车/ }),
    page.locator('xpath=//button[.//span[contains(normalize-space(.), "加入购物车")]]'),
    page.locator('button[class*="primaryBtn"]').filter({ hasText: /加入购物车/ }),
    page.locator('button[class*="leftBtn"]').filter({ hasText: /加入购物车/ }),
    page.locator('button[class*="btn"]').filter({ hasText: /加入购物车/ }),
    page.getByRole("button", { name: /加入购物车/ })
  ];

  for (const locator of candidateLocators) {
    const count = await locator.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const btn = locator.nth(i);

      const visible = await btn.isVisible().catch(() => false);
      if (!visible) continue;

      const enabled = await btn.isEnabled().catch(() => false);
      if (!enabled) continue;

      const text = normalizeText(await btn.innerText().catch(() => ""));

      if (!/加入购物车/.test(text)) continue;

      if (/立即购买|马上抢|提交订单|去结算|结算|付款|确认支付|购买|下单/.test(text)) {
        continue;
      }

      return btn;
    }
  }

  return null;
}

async function chooseSkuIfNeeded(page) {
  const candidates = page.locator(
    [
      '[class*="Sku"] button:not([disabled])',
      '[class*="sku"] button:not([disabled])',
      '[class*="Sku"] li:not([disabled])',
      '[class*="sku"] li:not([disabled])',
      'button:not([disabled])',
      'li:not([disabled])',
      'span:not([disabled])'
    ].join(",")
  );

  const count = await candidates.count().catch(() => 0);

  for (let i = 0; i < Math.min(count, 120); i++) {
    const el = candidates.nth(i);

    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;

    const text = normalizeText(await el.innerText({ timeout: 1000 }).catch(() => ""));

    if (!text) continue;

    if (/加入购物车|立即购买|购买|付款|结算|客服|收藏|分享|店铺|首页|搜索/.test(text)) {
      continue;
    }

    if (/缺货|无货|售罄|不可选|已选/.test(text)) {
      continue;
    }

    const box = await el.boundingBox().catch(() => null);
    if (!box || box.width < 10 || box.height < 10) continue;

    console.log(`尝试选择规格：${text}`);

    await el.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(800);

    return {
      selected: true,
      text
    };
  }

  return {
    selected: false,
    reason: "未找到可安全点击的规格项"
  };
}

async function addToCart(detailPage, productInfo, index) {
  await waitUntilPageUsable(detailPage, `before_add_cart_${index}`);

  const beforeText = await getBodyText(detailPage);
  const beforeUrl = detailPage.url();

  if (isWrongMyTaobaoPage(beforeText, beforeUrl)) {
    return {
      success: false,
      status: "WRONG_PAGE_NOT_PRODUCT_DETAIL",
      error: "当前页面是我的淘宝/账户页，不是商品详情页",
      current_url: beforeUrl,
      debug_text: beforeText.slice(0, 1000),
      screenshot: await screenshot(detailPage, `cart_${index}_wrong_page`)
    };
  }

  if (/已下架|商品不存在|卖光了|暂时缺货|库存不足|此商品已不能购买/.test(beforeText)) {
    return {
      success: false,
      status: "OUT_OF_STOCK",
      error: "商品下架、缺货或不可购买",
      current_url: beforeUrl,
      screenshot: await screenshot(detailPage, `cart_${index}_out_of_stock`)
    };
  }

  await detailPage.waitForSelector("button, span", {
    timeout: 20000
  }).catch(() => {});

  let btn = await findAddCartButton(detailPage);

  if (!btn) {
    await detailPage.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await detailPage.waitForTimeout(1000);
    btn = await findAddCartButton(detailPage);
  }

  if (!btn) {
    await detailPage.mouse.wheel(0, -1200).catch(() => {});
    await detailPage.waitForTimeout(1000);
    btn = await findAddCartButton(detailPage);
  }

  if (!btn) {
    const text = await getBodyText(detailPage);

    return {
      success: false,
      status: "ADD_CART_BUTTON_NOT_FOUND",
      error: "商品详情页未找到可点击的“加入购物车”按钮",
      current_url: detailPage.url(),
      debug_text: text.slice(0, 1000),
      screenshot: await screenshot(detailPage, `cart_${index}_button_not_found`)
    };
  }

  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await detailPage.waitForTimeout(500);

  console.log("点击加入购物车。");

  await btn.click({ timeout: 15000 });
  await detailPage.waitForTimeout(3000);
  await waitUntilPageUsable(detailPage, `after_first_add_cart_${index}`);

  let afterText = await getBodyText(detailPage);

  if (/成功加入购物车|已加入购物车|加入成功|商品已成功加入购物车|添加成功/.test(afterText)) {
    return {
      success: true,
      status: "SUCCESS",
      message: "加入购物车成功",
      current_url: detailPage.url(),
      screenshot: await screenshot(detailPage, `cart_${index}_success`)
    };
  }

  if (/请选择|选择规格|请选择规格|颜色|尺码|套餐|型号|版本/.test(afterText)) {
    console.log("检测到需要选择规格，尝试选择第一个可用规格。");

    const skuResult = await chooseSkuIfNeeded(detailPage);

    await detailPage.waitForTimeout(1000);
    btn = await findAddCartButton(detailPage);

    if (!btn) {
      return {
        success: false,
        status: "SKU_REQUIRED",
        error: "需要选择规格，但选择规格后仍未找到加入购物车按钮",
        sku_selection: skuResult,
        current_url: detailPage.url(),
        debug_text: afterText.slice(0, 1000),
        screenshot: await screenshot(detailPage, `cart_${index}_sku_no_button`)
      };
    }

    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await detailPage.waitForTimeout(500);

    console.log("选择规格后再次点击加入购物车。");

    await btn.click({ timeout: 15000 });
    await detailPage.waitForTimeout(3000);
    await waitUntilPageUsable(detailPage, `after_second_add_cart_${index}`);

    afterText = await getBodyText(detailPage);

    if (/成功加入购物车|已加入购物车|加入成功|商品已成功加入购物车|添加成功/.test(afterText)) {
      return {
        success: true,
        status: "SUCCESS",
        message: "选择规格后加入购物车成功",
        sku_selection: skuResult,
        current_url: detailPage.url(),
        screenshot: await screenshot(detailPage, `cart_${index}_success_after_sku`)
      };
    }

    return {
      success: false,
      status: "ADD_CART_RESULT_UNKNOWN",
      error: "选择规格并点击加入购物车后，未检测到成功提示",
      sku_selection: skuResult,
      current_url: detailPage.url(),
      debug_text: afterText.slice(0, 1000),
      screenshot: await screenshot(detailPage, `cart_${index}_unknown_after_sku`)
    };
  }

  return {
    success: false,
    status: "ADD_CART_RESULT_UNKNOWN",
    error: "点击加入购物车后未检测到成功提示，也未检测到规格提示",
    current_url: detailPage.url(),
    debug_text: afterText.slice(0, 1000),
    screenshot: await screenshot(detailPage, `cart_${index}_unknown`)
  };
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

  const context = await launchContext();
  const page = context.pages()[0] || await context.newPage();

  try {
    await closeExtraPages(context, page);

    await openTaobaoHome(page);
    await openSearchPage(page);

    const cardCount = await waitSearchCards(page);

    if (cardCount <= 0) {
      const shot = await screenshot(page, "search_no_cards");
      const text = await getBodyText(page);

      printJson("NO_RESULT", {
        error_code: "NO_RESULT",
        message: "搜索页未检测到商品卡片",
        current_url: page.url(),
        screenshot: shot,
        debug_text: text.slice(0, 1500)
      });

      await context.close();
      return;
    }

    const scanned = [];
    const matched = [];
    const maxLoop = Math.min(maxScan, cardCount);

    for (let i = 0; i < maxLoop; i++) {
      /**
       * 每次循环重新获取 locator，避免 DOM 刷新后旧 locator 失效。
       */
      const cardLocator = getSearchCardLocator(page);
      const currentCount = await cardLocator.count().catch(() => 0);

      if (i >= currentCount) {
        console.log(`第 ${i + 1} 个商品不存在，结束扫描。`);
        break;
      }

      const card = cardLocator.nth(i);
      const brief = await getCardBrief(card, i + 1);

      console.log("\n----------------------------------------------------");
      console.log(`开始检查综合排序第 ${i + 1} 个商品`);
      console.log(`标题：${brief.title}`);
      console.log(`价格：${brief.price}`);
      console.log(`销量：${brief.sales}`);
      console.log(`店铺：${brief.shop}`);
      console.log("----------------------------------------------------");

      let detailPage = null;
      let openedInSearchPage = false;

      try {
        detailPage = await openDetailByClick(page, card, i + 1);
        openedInSearchPage = detailPage === page;

        const detailText = await getBodyText(detailPage);
        const detailUrl = detailPage.url();

        if (isWrongMyTaobaoPage(detailText, detailUrl)) {
          const wrongInfo = {
            ...brief,
            detail_url: detailUrl,
            status: "WRONG_PAGE_NOT_PRODUCT_DETAIL",
            message: "点击商品后进入了我的淘宝/账户页，不是商品详情页"
          };

          scanned.push(wrongInfo);
          console.log("跳过：进入了我的淘宝/账户页。");

          if (!openedInSearchPage) {
            await detailPage.close().catch(() => {});
          }

          if (openedInSearchPage) {
            await openSearchPage(page);
            await waitSearchCards(page);
          }

          continue;
        }

        const productTitle = await extractProductTitle(detailPage);
        const goodRate = await parseGoodRateFromDetail(detailPage);

        const productInfo = {
          ...brief,
          product_title: productTitle,
          detail_url: detailUrl,
          good_rate: goodRate,
          rate_found: goodRate !== null
        };

        scanned.push(productInfo);

        console.log(`详情页标题：${productTitle}`);
        console.log(`详情页 URL：${detailUrl}`);
        console.log(`解析到好评率：${goodRate === null ? "未找到" : goodRate + "%"}`);

        if (goodRate === null) {
          console.log("未找到明确好评率，继续检查下一个商品。");

          if (!openedInSearchPage) {
            await detailPage.close().catch(() => {});
          } else {
            await openSearchPage(page);
            await waitSearchCards(page);
          }

          continue;
        }

        if (goodRate <= minGoodRate) {
          console.log(`好评率 ${goodRate}% 不大于阈值 ${minGoodRate}%，继续检查下一个商品。`);

          if (!openedInSearchPage) {
            await detailPage.close().catch(() => {});
          } else {
            await openSearchPage(page);
            await waitSearchCards(page);
          }

          continue;
        }

        console.log(`命中商品：好评率 ${goodRate}% > ${minGoodRate}%，准备加入购物车。`);

        const cartResult = await addToCart(detailPage, productInfo, i + 1);

        const resultProduct = {
          ...productInfo,
          cart_success: cartResult.success,
          cart_result: cartResult.status,
          cart_detail: cartResult
        };

        matched.push(resultProduct);

        if (!openedInSearchPage) {
          await detailPage.close().catch(() => {});
        }

        const successCount = matched.filter((p) => p.cart_success).length;

        if (successCount >= targetCount) {
          printJson("SUCCESS", {
            matched_count: matched.length,
            cart_success_count: successCount,
            products: matched,
            scanned_count: scanned.length,
            scanned_products: scanned
          });

          await context.close();
          return;
        }

        console.log(`当前商品加购结果：${cartResult.status}，继续检查下一个商品。`);

        if (openedInSearchPage) {
          await openSearchPage(page);
          await waitSearchCards(page);
        }
      } catch (err) {
        const errorInfo = {
          ...brief,
          status: "DETAIL_OR_CART_ERROR",
          error: String(err.message || err).slice(0, 500)
        };

        scanned.push(errorInfo);

        console.log(`第 ${i + 1} 个商品处理异常：${errorInfo.error}`);

        if (detailPage && detailPage !== page) {
          await detailPage.close().catch(() => {});
        }

        if (page.isClosed()) {
          break;
        }

        if (!/s\.taobao\.com\/search/.test(page.url())) {
          await openSearchPage(page);
          await waitSearchCards(page);
        }
      }
    }

    const rateFoundCount = scanned.filter((p) => p.rate_found).length;
    const matchedCount = matched.length;
    const successCount = matched.filter((p) => p.cart_success).length;

    let status = "NO_MATCHED_PRODUCT";

    if (successCount > 0) {
      status = "PARTIAL_SUCCESS";
    } else if (rateFoundCount === 0) {
      status = "RATE_NOT_FOUND";
    } else if (matchedCount > 0) {
      status = "ADD_CART_FAILED";
    }

    printJson(status, {
      error_code: status,
      message:
        status === "RATE_NOT_FOUND"
          ? `从综合排序第 1 个商品开始检查，共检查 ${scanned.length} 个商品，未找到明确好评率字段。`
          : `从综合排序第 1 个商品开始检查，共检查 ${scanned.length} 个商品，未找到满足条件并成功加入购物车的商品。`,
      scanned_count: scanned.length,
      rate_found_count: rateFoundCount,
      matched_count: matchedCount,
      cart_success_count: successCount,
      products: matched,
      scanned_products: scanned
    });

    await context.close();
  } catch (err) {
    const shot = page && !page.isClosed() ? await screenshot(page, "browser_error") : null;

    printJson("BROWSER_ERROR", {
      error_code: "BROWSER_ERROR",
      message: String(err.message || err),
      screenshot: shot
    });

    await context.close().catch(() => {});
  }
}

main();

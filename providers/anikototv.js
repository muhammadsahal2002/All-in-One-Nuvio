/**
 * Minimal AnikotoTV Tester
 * Run: node test-anikoto.js
 */

const cheerio = require("cheerio"); // use "cheerio" for local testing

const CONFIG = {
    BASE_URL: "https://anikoto.cz",
    USER_AGENT: "Mozilla/5.0 (Linux; Android 12; SM-M025F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.181 Mobile Safari/537.36",
    TIMEOUT: 20000
};

function headers(extra = {}) {
    return {
        "User-Agent": CONFIG.USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        ...extra
    };
}

function ajaxHeaders(referer) {
    return {
        "User-Agent": CONFIG.USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Referer": referer || CONFIG.BASE_URL
    };
}

async function fetchText(url, opts = {}) {
    const res = await fetch(url, {
        ...opts,
        signal: AbortSignal.timeout(CONFIG.TIMEOUT)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

// ==================== STEP 1: SEARCH ====================
async function testSearch(query) {
    console.log("\n========== STEP 1: SEARCH ==========");
    const url = `\( {CONFIG.BASE_URL}/filter?keyword= \){encodeURIComponent(query)}`;
    console.log("URL:", url);

    const html = await fetchText(url, { headers: headers() });
    console.log("HTML length:", html.length);

    const $ = cheerio.load(html);
    const results = [];

    $("div.item").each((i, el) => {
        const $el = $(el);
        const titleEl = $el.find("a.name.d-title, a[data-jp]").first();
        if (!titleEl.length) return;

        const href = titleEl.attr("href");
        const title = (titleEl.attr("data-jp") || titleEl.text()).trim();
        if (!href || !title) return;

        results.push({
            title,
            url: href.startsWith("http") ? href : CONFIG.BASE_URL + href
        });
    });

    console.log(`Found ${results.length} results`);
    results.slice(0, 5).forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.title}`);
        console.log(`     ${r.url}`);
    });

    return results;
}

// ==================== STEP 2: LOAD ANIME + EPISODES ====================
async function testLoadAnime(watchUrl) {
    console.log("\n========== STEP 2: LOAD ANIME + EPISODES ==========");
    console.log("Watch URL:", watchUrl);

    const html = await fetchText(watchUrl, { headers: headers() });
    const $ = cheerio.load(html);

    let title = $("h1.title, h1[itemprop=name], h1").first().text().trim();
    console.log("Title:", title);

    let animeId = $("[data-id]").first().attr("data-id");
    if (!animeId) {
        const m = html.match(/data-id=["'](\d+)["']/);
        animeId = m ? m[1] : null;
    }
    console.log("Anime ID:", animeId);

    if (!animeId) throw new Error("No animeId found");

    // Get episodes
    const epUrl = `\( {CONFIG.BASE_URL}/ajax/episode/list/ \){animeId}?vrf=`;
    console.log("Episode list URL:", epUrl);

    const epJson = await fetchText(epUrl, { headers: ajaxHeaders(watchUrl) });
    const epData = JSON.parse(epJson);

    if (epData.status !== 200 || !epData.result) {
        throw new Error("Failed to get episode list");
    }

    const $ep = cheerio.load(epData.result);
    const episodes = [];

    $ep("a[data-ids]").each((i, el) => {
        const $el = $ep(el);
        const num = parseInt($el.attr("data-num") || "0");
        const hasSub = $el.attr("data-sub") === "1";
        const hasDub = $el.attr("data-dub") === "1";
        const ids = $el.attr("data-ids");
        const name = $el.closest("li").attr("title") || `Episode ${num}`;

        if (hasSub) episodes.push({ number: num, type: "sub", ids, name });
        if (hasDub) episodes.push({ number: num, type: "dub", ids, name });
    });

    console.log(`Total episode entries: ${episodes.length}`);
    const ep1 = episodes.filter(e => e.number === 1);
    console.log("Episode 1 options:", ep1.map(e => e.type).join(", ") || "none");

    return { title, animeId, watchUrl, episodes };
}

// ==================== STEP 3: GET STREAM (SUB + DUB) ====================
async function testGetStream(anime, epNum = 1, type = "sub") {
    console.log(`\n========== STEP 3: GET STREAM (${type.toUpperCase()}) ==========`);

    const ep = anime.episodes.find(e => e.number === epNum && e.type === type);
    if (!ep) {
        console.log(`No ${type} found for episode ${epNum}`);
        return null;
    }

    console.log("Using episode:", ep.name, `(${ep.type})`);

    // Server list
    const listUrl = `\( {CONFIG.BASE_URL}/ajax/server/list?servers= \){ep.ids}`;
    const listJson = await fetchText(listUrl, { headers: ajaxHeaders(anime.watchUrl) });
    const listData = JSON.parse(listJson);

    if (listData.status !== 200 || !listData.result) {
        throw new Error("Failed to get server list");
    }

    const $ = cheerio.load(listData.result);
    const typeSelector = type === "dub"
        ? 'div.type[data-type="dub"]'
        : 'div.type[data-type="sub"], div.type[data-type="hsub"]';

    const linkIds = [];
    $(typeSelector).find("li[data-link-id]").each((i, el) => {
        const id = $(el).attr("data-link-id");
        if (id) linkIds.push(id);
    });

    console.log(`Found ${linkIds.length} servers for ${type}`);

    if (linkIds.length === 0) return null;

    // Get first server
    const serverUrl = `\( {CONFIG.BASE_URL}/ajax/server?get= \){linkIds[0]}`;
    const serverJson = await fetchText(serverUrl, { headers: ajaxHeaders(anime.watchUrl) });
    const serverData = JSON.parse(serverJson);

    let embedUrl = null;
    if (serverData.status === 200 && serverData.result) {
        embedUrl = typeof serverData.result === "string"
            ? serverData.result
            : serverData.result.url;
    }

    console.log("Embed URL:", embedUrl);
    return embedUrl;
}

// ==================== RUN ALL ====================
async function main() {
    try {
        // Change the search query here
        const query = "Alya sometimes";

        // Step 1
        const results = await testSearch(query);
        if (results.length === 0) {
            console.log("\n❌ Search failed - no results");
            return;
        }

        // Step 2
        const anime = await testLoadAnime(results[0].url);
        if (!anime.episodes.length) {
            console.log("\n❌ No episodes found");
            return;
        }

        // Step 3 - SUB
        const subUrl = await testGetStream(anime, 1, "sub");
        // Step 3 - DUB
        const dubUrl = await testGetStream(anime, 1, "dub");

        console.log("\n========== FINAL RESULT ==========");
        console.log("SUB:", subUrl || "FAILED");
        console.log("DUB:", dubUrl || "FAILED");

    } catch (err) {
        console.error("\n❌ Error:", err.message);
    }
}

main();
/**
 * AnikotoTV Provider for Nuvio
 * Updated for anikoto.cz + current MegaPlay flow
 * Supports SUB + DUB
 */

"use strict";

const cheerio = require("cheerio-without-node-native");

// ============================================
// Configuration
// ============================================

const CONFIG = {
    BASE_URL: "https://anikoto.cz",
    TMDB_API_KEY: "439c478a771f35c05022f9feabcca01c",
    TMDB_BASE: "https://api.themoviedb.org/3",
    USER_AGENT: "Mozilla/5.0 (Linux; Android 12; SM-M025F Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.181 Mobile Safari/537.36",
    TIMEOUT: 25000
};

function getHeaders(extra = {}) {
    return {
        "User-Agent": CONFIG.USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        ...extra
    };
}

function getAjaxHeaders(referer) {
    return {
        "User-Agent": CONFIG.USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Referer": referer || CONFIG.BASE_URL,
        "Accept-Language": "en-US,en;q=0.9"
    };
}

function fetchWithTimeout(url, options = {}, timeout = CONFIG.TIMEOUT) {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        fetch(url, { ...options, signal: controller.signal })
            .then(response => {
                clearTimeout(timeoutId);
                resolve(response);
            })
            .catch(error => {
                clearTimeout(timeoutId);
                reject(error);
            });
    });
}

function jsonResultString(jsonText) {
    try {
        const data = JSON.parse(jsonText);
        if (data.status === 200 && data.result) {
            return typeof data.result === "string" ? data.result : null;
        }
        return null;
    } catch {
        return null;
    }
}

function jsonResultUrl(jsonText) {
    try {
        const data = JSON.parse(jsonText);
        if (data.status === 200 && data.result) {
            if (typeof data.result === "string") {
                return data.result;
            }
            if (data.result && typeof data.result === "object" && data.result.url) {
                return data.result.url;
            }
        }
        return null;
    } catch {
        return null;
    }
}

// ============================================
// TMDB Helper
// ============================================

function getTMDBDetails(id, mediaType, season, episode) {
    return new Promise((resolve) => {
        try {
            const type = (mediaType === "tv" || mediaType === "series") ? "tv" : "movie";
            let url = `\( {CONFIG.TMDB_BASE}/ \){type}/\( {id}?api_key= \){CONFIG.TMDB_API_KEY}&language=en-US`;

            if (String(id).startsWith("tt")) {
                url = `\( {CONFIG.TMDB_BASE}/find/ \){id}?external_source=imdb_id&api_key=${CONFIG.TMDB_API_KEY}`;
            }

            fetchWithTimeout(url)
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    if (!data) return resolve(null);

                    let result = data;
                    if (String(id).startsWith("tt")) {
                        const results = type === "tv" ? data.tv_results : data.movie_results;
                        result = results && results[0] ? results[0] : null;
                        if (!result) return resolve(null);
                    }

                    const title = type === "tv" ? result.name : result.title;
                    resolve({ title, id: result.id, type });
                })
                .catch(() => resolve(null));
        } catch {
            resolve(null);
        }
    });
}

// ============================================
// Search
// ============================================

function searchAnime(query) {
    return new Promise((resolve) => {
        const url = `\( {CONFIG.BASE_URL}/filter?keyword= \){encodeURIComponent(query)}`;
        console.log(`[AnikotoTV] Searching: ${url}`);

        fetchWithTimeout(url, { headers: getHeaders() })
            .then(r => r.ok ? r.text() : null)
            .then(html => {
                if (!html) return resolve([]);

                const $ = cheerio.load(html);
                const results = [];

                $("div.item").each((i, el) => {
                    const $el = $(el);
                    const titleEl = $el.find("a.name.d-title, a[data-jp]").first();
                    if (!titleEl.length) return;

                    const href = titleEl.attr("href");
                    let title = titleEl.attr("data-jp") || titleEl.text().trim();
                    if (!href || !title) return;

                    const fullUrl = href.startsWith("http") ? href : `\( {CONFIG.BASE_URL} \){href}`;

                    let poster = null;
                    const img = $el.find("img").first();
                    if (img.length) {
                        poster = img.attr("data-src") || img.attr("src");
                        if (poster && poster.startsWith("//")) poster = "https:" + poster;
                    }

                    results.push({
                        title,
                        url: fullUrl,
                        posterUrl: poster
                    });
                });

                console.log(`[AnikotoTV] Found ${results.length} results`);
                resolve(results);
            })
            .catch(err => {
                console.error("[AnikotoTV] Search error:", err.message);
                resolve([]);
            });
    });
}

// ============================================
// Episode List
// ============================================

function getEpisodes(animeId, referer) {
    return new Promise((resolve) => {
        const url = `\( {CONFIG.BASE_URL}/ajax/episode/list/ \){animeId}?vrf=`;
        console.log(`[AnikotoTV] Fetching episodes: ${url}`);

        fetchWithTimeout(url, { headers: getAjaxHeaders(referer) })
            .then(r => r.ok ? r.text() : null)
            .then(jsonText => {
                const html = jsonResultString(jsonText);
                if (!html) {
                    console.log("[AnikotoTV] No episode HTML");
                    return resolve([]);
                }

                const $ = cheerio.load(html);
                const episodes = [];

                $("a[data-ids]").each((i, el) => {
                    const $el = $(el);
                    const serverIds = $el.attr("data-ids");
                    const num = parseInt($el.attr("data-num") || "0", 10);
                    const hasSub = $el.attr("data-sub") === "1";
                    const hasDub = $el.attr("data-dub") === "1";
                    const title = $el.closest("li").attr("title") || `Episode ${num}`;

                    if (!serverIds) return;

                    if (hasSub) {
                        episodes.push({
                            name: title,
                            url: `anikoto|\( {referer}| \){serverIds}|sub`,
                            number: num,
                            type: "sub"
                        });
                    }
                    if (hasDub) {
                        episodes.push({
                            name: title + " (Dub)",
                            url: `anikoto|\( {referer}| \){serverIds}|dub`,
                            number: num,
                            type: "dub"
                        });
                    }
                });

                console.log(`[AnikotoTV] Parsed ${episodes.length} episode entries`);
                resolve(episodes);
            })
            .catch(err => {
                console.error("[AnikotoTV] getEpisodes error:", err.message);
                resolve([]);
            });
    });
}

// ============================================
// Resolve Episode → Server → MegaPlay
// ============================================

function resolveEpisode(data, callback) {
    return new Promise((resolve) => {
        try {
            const parts = data.split("|");
            if (parts.length < 4) return resolve(false);

            const referer = parts[1];
            const serverIds = parts[2];
            const audioType = parts[3] || "sub"; // "sub" or "dub"

            const serverListUrl = `\( {CONFIG.BASE_URL}/ajax/server/list?servers= \){serverIds}`;
            console.log(`[AnikotoTV] Server list (${audioType}): ${serverListUrl.substring(0, 80)}...`);

            fetchWithTimeout(serverListUrl, { headers: getAjaxHeaders(referer) })
                .then(r => r.ok ? r.text() : null)
                .then(serverJson => {
                    const serverHtml = jsonResultString(serverJson);
                    if (!serverHtml) {
                        console.log("[AnikotoTV] No server HTML");
                        return resolve(false);
                    }

                    const $ = cheerio.load(serverHtml);
                    let linkIds = [];

                    // Strictly select the correct type (sub / dub)
                    const typeSelector = audioType === "dub"
                        ? 'div.type[data-type="dub"]'
                        : 'div.type[data-type="sub"], div.type[data-type="hsub"]';

                    const typeEl = $(typeSelector);

                    if (typeEl.length) {
                        typeEl.find("li[data-link-id]").each((i, el) => {
                            const linkId = $(el).attr("data-link-id");
                            if (linkId && !linkIds.includes(linkId)) {
                                linkIds.push(linkId);
                            }
                        });
                    }

                    // Fallback
                    if (linkIds.length === 0) {
                        $("li[data-link-id]").each((i, el) => {
                            const linkId = $(el).attr("data-link-id");
                            if (linkId && !linkIds.includes(linkId)) {
                                linkIds.push(linkId);
                            }
                        });
                    }

                    console.log(`[AnikotoTV] Found ${linkIds.length} linkIds for ${audioType}`);

                    if (linkIds.length === 0) return resolve(false);

                    let found = false;
                    let processed = 0;

                    for (const linkId of linkIds) {
                        const serverUrl = `\( {CONFIG.BASE_URL}/ajax/server?get= \){linkId}`;

                        fetchWithTimeout(serverUrl, { headers: getAjaxHeaders(referer) })
                            .then(r => r.ok ? r.text() : null)
                            .then(sJson => {
                                processed++;
                                if (!sJson) {
                                    if (processed >= linkIds.length && !found) resolve(false);
                                    return;
                                }

                                const embedUrl = jsonResultUrl(sJson);
                                if (!embedUrl) {
                                    if (processed >= linkIds.length && !found) resolve(false);
                                    return;
                                }

                                console.log(`[AnikotoTV] Embed URL: ${embedUrl}`);

                                // Only handle MegaPlay for now
                                if (embedUrl.includes("megaplay.buzz") || embedUrl.includes("vidtube") || embedUrl.includes("vidwish")) {
                                    extractMegaPlay(embedUrl, referer, callback)
                                        .then(success => {
                                            if (success) {
                                                found = true;
                                                resolve(true);
                                            } else if (processed >= linkIds.length && !found) {
                                                resolve(false);
                                            }
                                        });
                                } else {
                                    if (processed >= linkIds.length && !found) resolve(false);
                                }
                            })
                            .catch(() => {
                                processed++;
                                if (processed >= linkIds.length && !found) resolve(false);
                            });
                    }
                })
                .catch(() => resolve(false));
        } catch (err) {
            console.error("[AnikotoTV] resolveEpisode error:", err.message);
            resolve(false);
        }
    });
}

// ============================================
// MegaPlay Extractor
// ============================================

function extractMegaPlay(url, referer, callback) {
    return new Promise((resolve) => {
        const headers = getHeaders({
            "Referer": referer || CONFIG.BASE_URL,
            "Origin": CONFIG.BASE_URL
        });

        // Normalize URL
        if (!url.includes("autostart=true")) {
            url = url + (url.includes("?") ? "&" : "?") + "autostart=true";
        }

        console.log(`[AnikotoTV] Extracting MegaPlay: ${url}`);

        fetchWithTimeout(url, { headers })
            .then(r => r.ok ? r.text() : null)
            .then(html => {
                if (!html) {
                    console.log("[AnikotoTV] Empty MegaPlay page");
                    return resolve(false);
                }

                // Method 1: Classic data-id → getSources
                let dataIdMatch = html.match(/data-id=["'](\d+)["']/);

                if (dataIdMatch) {
                    const dataId = dataIdMatch[1];
                    const sourcesUrl = `https://megaplay.buzz/stream/getSources?id=${dataId}`;

                    return fetchWithTimeout(sourcesUrl, {
                        headers: {
                            ...getAjaxHeaders(url),
                            "Referer": url
                        }
                    })
                        .then(r => r.ok ? r.json() : null)
                        .then(sourcesData => {
                            if (!sourcesData || !sourcesData.sources) {
                                return resolve(false);
                            }

                            let videoUrl = null;
                            if (typeof sourcesData.sources === "object" && sourcesData.sources.file) {
                                videoUrl = sourcesData.sources.file;
                            } else if (Array.isArray(sourcesData.sources) && sourcesData.sources.length > 0) {
                                videoUrl = sourcesData.sources[0].file;
                            }

                            if (!videoUrl) return resolve(false);

                            let quality = "1080p";
                            // Try to detect quality from m3u8 if possible
                            callback({
                                url: videoUrl,
                                quality: quality,
                                headers: {
                                    "Referer": "https://megaplay.buzz/",
                                    "Origin": "https://megaplay.buzz"
                                }
                            });
                            resolve(true);
                        })
                        .catch(() => resolve(false));
                }

                // Method 2: Look for direct m3u8 in page
                const m3u8Match = html.match(/(https?:\/\/[^"'\\s]+\.m3u8[^"'\\s]*)/i);
                if (m3u8Match) {
                    callback({
                        url: m3u8Match[1],
                        quality: "1080p",
                        headers: {
                            "Referer": "https://megaplay.buzz/",
                            "Origin": "https://megaplay.buzz"
                        }
                    });
                    return resolve(true);
                }

                console.log("[AnikotoTV] Could not extract stream from MegaPlay");
                resolve(false);
            })
            .catch(err => {
                console.error("[AnikotoTV] MegaPlay error:", err.message);
                resolve(false);
            });
    });
}

// ============================================
// Load Anime Details
// ============================================

function loadAnime(url) {
    return new Promise((resolve) => {
        fetchWithTimeout(url, { headers: getHeaders() })
            .then(r => r.ok ? r.text() : null)
            .then(html => {
                if (!html) return resolve(null);

                const $ = cheerio.load(html);

                let title = $("h1.title, h1[itemprop=name]").first().text().trim();
                if (!title) title = $("h1").first().text().trim();
                if (!title) return resolve(null);

                let animeId = null;
                const idEl = $("[data-id]").first();
                if (idEl.length) {
                    animeId = idEl.attr("data-id");
                }
                if (!animeId) {
                    const idMatch = html.match(/data-id=["'](\d+)["']/);
                    if (idMatch) animeId = idMatch[1];
                }

                if (!animeId) {
                    console.log("[AnikotoTV] No animeId found");
                    return resolve(null);
                }

                getEpisodes(animeId, url)
                    .then(episodes => {
                        resolve({
                            title,
                            animeId,
                            url,
                            episodes
                        });
                    })
                    .catch(() => resolve(null));
            })
            .catch(() => resolve(null));
    });
}

// ============================================
// Main Entry Point
// ============================================

function getStreams(tmdbId, mediaType, season, episode) {
    return new Promise((resolve) => {
        const log = (msg) => console.log(`[AnikotoTV] ${msg}`);

        log(`Request: ${tmdbId} | \( {mediaType} | S \){season || "?"}E${episode || "?"}`);

        let searchTitle = String(tmdbId);

        getTMDBDetails(tmdbId, mediaType, season, episode)
            .then(tmdbInfo => {
                if (tmdbInfo && tmdbInfo.title) {
                    searchTitle = tmdbInfo.title;
                    log(`TMDB title: ${searchTitle}`);
                }
                return searchAnime(searchTitle);
            })
            .then(searchResults => {
                if (!searchResults || searchResults.length === 0) {
                    log("No search results");
                    return resolve([]);
                }

                // Best match
                let bestMatch = searchResults[0];
                const queryLower = searchTitle.toLowerCase();

                for (const r of searchResults) {
                    const t = r.title.toLowerCase();
                    if (t === queryLower) {
                        bestMatch = r;
                        break;
                    }
                    if (t.includes(queryLower) || queryLower.includes(t)) {
                        bestMatch = r;
                    }
                }

                log(`Best match: ${bestMatch.title}`);
                return loadAnime(bestMatch.url);
            })
            .then(details => {
                if (!details || !details.episodes || details.episodes.length === 0) {
                    log("No episodes found");
                    return resolve([]);
                }

                const epNum = episode || 1;
                let targetEpisodes = details.episodes.filter(ep => ep.number === epNum);

                if (targetEpisodes.length === 0) {
                    // Fallback: take closest
                    const sorted = [...details.episodes].sort((a, b) => a.number - b.number);
                    const idx = Math.min(Math.max(epNum - 1, 0), sorted.length - 1);
                    targetEpisodes = [sorted[idx]];
                }

                log(`Target episodes: ${targetEpisodes.map(e => e.type).join(", ")}`);

                const streams = [];
                let pending = targetEpisodes.length;

                if (pending === 0) return resolve([]);

                const checkDone = () => {
                    pending--;
                    if (pending <= 0) {
                        log(`Returning ${streams.length} streams`);
                        resolve(streams);
                    }
                };

                for (const ep of targetEpisodes) {
                    const callback = (link) => {
                        streams.push({
                            name: "AnikotoTV",
                            title: `${link.quality || "1080p"} ${ep.type.toUpperCase()}`,
                            url: link.url,
                            quality: link.quality || "1080p",
                            headers: link.headers || {}
                        });
                    };

                    resolveEpisode(ep.url, callback)
                        .then(() => checkDone())
                        .catch(() => checkDone());
                }
            })
            .catch(err => {
                console.error("[AnikotoTV] Fatal error:", err.message);
                resolve([]);
            });
    });
}

module.exports = { getStreams };
/**
 * AnikotoTV Provider for Nuvio
 * Working version (anikoto.cz + MegaPlay)
 */

"use strict";

const cheerio = require("cheerio-without-node-native");

const CONFIG = {
    BASE_URL: "https://anikoto.cz",
    TMDB_API_KEY: "439c478a771f35c05022f9feabcca01c",
    TMDB_BASE: "https://api.themoviedb.org/3",
    USER_AGENT: "Mozilla/5.0 (Linux; Android 12; SM-M025F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.181 Mobile Safari/537.36",
    TIMEOUT: 25000
};

function getHeaders(extra) {
    return Object.assign({
        "User-Agent": CONFIG.USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
    }, extra || {});
}

function getAjaxHeaders(referer) {
    return {
        "User-Agent": CONFIG.USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Referer": referer || CONFIG.BASE_URL
    };
}

function fetchWithTimeout(url, options, timeout) {
    timeout = timeout || CONFIG.TIMEOUT;
    return new Promise(function(resolve, reject) {
        const controller = new AbortController();
        const timeoutId = setTimeout(function() { controller.abort(); }, timeout);

        fetch(url, Object.assign({}, options, { signal: controller.signal }))
            .then(function(response) {
                clearTimeout(timeoutId);
                resolve(response);
            })
            .catch(function(error) {
                clearTimeout(timeoutId);
                reject(error);
            });
    });
}

function jsonResultString(jsonText) {
    try {
        const data = JSON.parse(jsonText);
        if (data.status === 200 && data.result && typeof data.result === "string") {
            return data.result;
        }
        return null;
    } catch (e) {
        return null;
    }
}

function jsonResultUrl(jsonText) {
    try {
        const data = JSON.parse(jsonText);
        if (data.status === 200 && data.result) {
            if (typeof data.result === "string") return data.result;
            if (data.result.url) return data.result.url;
        }
        return null;
    } catch (e) {
        return null;
    }
}

// ==================== TMDB ====================
function getTMDBDetails(id, mediaType) {
    return new Promise(function(resolve) {
        const type = (mediaType === "tv" || mediaType === "series") ? "tv" : "movie";
        let url = CONFIG.TMDB_BASE + "/" + type + "/" + id + "?api_key=" + CONFIG.TMDB_API_KEY + "&language=en-US";

        if (String(id).indexOf("tt") === 0) {
            url = CONFIG.TMDB_BASE + "/find/" + id + "?external_source=imdb_id&api_key=" + CONFIG.TMDB_API_KEY;
        }

        fetchWithTimeout(url)
            .then(function(r) { return r.ok ? r.json() : null; })
            .then(function(data) {
                if (!data) return resolve(null);
                let result = data;
                if (String(id).indexOf("tt") === 0) {
                    const results = type === "tv" ? data.tv_results : data.movie_results;
                    result = results && results[0] ? results[0] : null;
                }
                if (!result) return resolve(null);
                resolve({ title: type === "tv" ? result.name : result.title });
            })
            .catch(function() { resolve(null); });
    });
}

// ==================== SEARCH ====================
function searchAnime(query) {
    return new Promise(function(resolve) {
        const url = CONFIG.BASE_URL + "/filter?keyword=" + encodeURIComponent(query);
        console.log("[AnikotoTV] Searching: " + url);

        fetchWithTimeout(url, { headers: getHeaders() })
            .then(function(r) { return r.ok ? r.text() : null; })
            .then(function(html) {
                if (!html) return resolve([]);
                const $ = cheerio.load(html);
                const results = [];

                $("div.item").each(function(i, el) {
                    const $el = $(el);
                    const titleEl = $el.find("a.name.d-title, a[data-jp]").first();
                    if (!titleEl.length) return;

                    const href = titleEl.attr("href");
                    const title = (titleEl.attr("data-jp") || titleEl.text()).trim();
                    if (!href || !title) return;

                    results.push({
                        title: title,
                        url: href.indexOf("http") === 0 ? href : CONFIG.BASE_URL + href
                    });
                });

                console.log("[AnikotoTV] Found " + results.length + " results");
                resolve(results);
            })
            .catch(function(err) {
                console.error("[AnikotoTV] Search error:", err.message);
                resolve([]);
            });
    });
}

// ==================== EPISODES ====================
function getEpisodes(animeId, referer) {
    return new Promise(function(resolve) {
        const url = CONFIG.BASE_URL + "/ajax/episode/list/" + animeId + "?vrf=";

        fetchWithTimeout(url, { headers: getAjaxHeaders(referer) })
            .then(function(r) { return r.ok ? r.text() : null; })
            .then(function(jsonText) {
                const html = jsonResultString(jsonText);
                if (!html) return resolve([]);

                const $ = cheerio.load(html);
                const episodes = [];

                $("a[data-ids]").each(function(i, el) {
                    const $el = $(el);
                    const serverIds = $el.attr("data-ids");
                    const num = parseInt($el.attr("data-num") || "0", 10);
                    const hasSub = $el.attr("data-sub") === "1";
                    const hasDub = $el.attr("data-dub") === "1";
                    const name = $el.closest("li").attr("title") || ("Episode " + num);

                    if (!serverIds) return;

                    if (hasSub) {
                        episodes.push({ name: name, url: "anikoto|" + referer + "|" + serverIds + "|sub", number: num, type: "sub" });
                    }
                    if (hasDub) {
                        episodes.push({ name: name + " (Dub)", url: "anikoto|" + referer + "|" + serverIds + "|dub", number: num, type: "dub" });
                    }
                });

                console.log("[AnikotoTV] Parsed " + episodes.length + " episode entries");
                resolve(episodes);
            })
            .catch(function() { resolve([]); });
    });
}

// ==================== RESOLVE EPISODE ====================
function resolveEpisode(data, callback) {
    return new Promise(function(resolve) {
        const parts = data.split("|");
        if (parts.length < 4) return resolve(false);

        const referer = parts[1];
        const serverIds = parts[2];
        const audioType = parts[3] || "sub";

        const serverListUrl = CONFIG.BASE_URL + "/ajax/server/list?servers=" + serverIds;

        fetchWithTimeout(serverListUrl, { headers: getAjaxHeaders(referer) })
            .then(function(r) { return r.ok ? r.text() : null; })
            .then(function(serverJson) {
                const serverHtml = jsonResultString(serverJson);
                if (!serverHtml) return resolve(false);

                const $ = cheerio.load(serverHtml);
                const linkIds = [];
                const typeSelector = audioType === "dub"
                    ? 'div.type[data-type="dub"]'
                    : 'div.type[data-type="sub"], div.type[data-type="hsub"]';

                $(typeSelector).find("li[data-link-id]").each(function(i, el) {
                    const linkId = $(el).attr("data-link-id");
                    if (linkId && linkIds.indexOf(linkId) === -1) linkIds.push(linkId);
                });

                if (linkIds.length === 0) return resolve(false);

                let found = false;
                let processed = 0;

                linkIds.forEach(function(linkId) {
                    const serverUrl = CONFIG.BASE_URL + "/ajax/server?get=" + linkId;

                    fetchWithTimeout(serverUrl, { headers: getAjaxHeaders(referer) })
                        .then(function(r) { return r.ok ? r.text() : null; })
                        .then(function(sJson) {
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

                            if (embedUrl.indexOf("megaplay.buzz") !== -1) {
                                extractMegaPlay(embedUrl, referer, callback)
                                    .then(function(success) {
                                        if (success) {
                                            found = true;
                                            resolve(true);
                                        } else if (processed >= linkIds.length && !found) {
                                            resolve(false);
                                        }
                                    });
                            } else if (processed >= linkIds.length && !found) {
                                resolve(false);
                            }
                        })
                        .catch(function() {
                            processed++;
                            if (processed >= linkIds.length && !found) resolve(false);
                        });
                });
            })
            .catch(function() { resolve(false); });
    });
}

// ==================== MEGAPLAY EXTRACTOR ====================
function extractMegaPlay(url, referer, callback) {
    return new Promise(function(resolve) {
        if (url.indexOf("autostart=true") === -1) {
            url += (url.indexOf("?") === -1 ? "?" : "&") + "autostart=true";
        }

        fetchWithTimeout(url, {
            headers: getHeaders({
                "Referer": referer || CONFIG.BASE_URL,
                "Origin": CONFIG.BASE_URL
            })
        })
            .then(function(r) { return r.ok ? r.text() : null; })
            .then(function(html) {
                if (!html) return resolve(false);

                const dataIdMatch = html.match(/data-id=["'](\d+)["']/);
                if (!dataIdMatch) return resolve(false);

                const dataId = dataIdMatch[1];
                const sourcesUrl = "https://megaplay.buzz/stream/getSources?id=" + dataId;

                return fetchWithTimeout(sourcesUrl, {
                    headers: {
                        "User-Agent": CONFIG.USER_AGENT,
                        "X-Requested-With": "XMLHttpRequest",
                        "Referer": url,
                        "Accept": "application/json, text/javascript, */*; q=0.01"
                    }
                })
                    .then(function(r) { return r.ok ? r.json() : null; })
                    .then(function(sourcesData) {
                        if (!sourcesData || !sourcesData.sources) return resolve(false);

                        let videoUrl = null;
                        if (typeof sourcesData.sources === "object" && sourcesData.sources.file) {
                            videoUrl = sourcesData.sources.file;
                        } else if (Array.isArray(sourcesData.sources) && sourcesData.sources.length > 0) {
                            videoUrl = sourcesData.sources[0].file;
                        }

                        if (!videoUrl) return resolve(false);

                        callback({
                            url: videoUrl,
                            quality: "1080p",
                            headers: {
                                "Referer": "https://megaplay.buzz/",
                                "Origin": "https://megaplay.buzz"
                            }
                        });
                        resolve(true);
                    })
                    .catch(function() { resolve(false); });
            })
            .catch(function() { resolve(false); });
    });
}

// ==================== LOAD ANIME ====================
function loadAnime(url) {
    return new Promise(function(resolve) {
        fetchWithTimeout(url, { headers: getHeaders() })
            .then(function(r) { return r.ok ? r.text() : null; })
            .then(function(html) {
                if (!html) return resolve(null);

                const $ = cheerio.load(html);
                let title = $("h1.title, h1[itemprop=name], h1").first().text().trim();
                if (!title) return resolve(null);

                let animeId = $("[data-id]").first().attr("data-id");
                if (!animeId) {
                    const m = html.match(/data-id=["'](\d+)["']/);
                    animeId = m ? m[1] : null;
                }
                if (!animeId) return resolve(null);

                getEpisodes(animeId, url).then(function(episodes) {
                    resolve({ title: title, animeId: animeId, url: url, episodes: episodes });
                });
            })
            .catch(function() { resolve(null); });
    });
}

// ==================== MAIN ====================
function getStreams(tmdbId, mediaType, season, episode) {
    return new Promise(function(resolve) {
        console.log("[AnikotoTV] Request: " + tmdbId + " | " + mediaType + " | S" + (season || "?") + "E" + (episode || "?"));

        let searchTitle = String(tmdbId);

        getTMDBDetails(tmdbId, mediaType)
            .then(function(tmdbInfo) {
                if (tmdbInfo && tmdbInfo.title) {
                    searchTitle = tmdbInfo.title;
                    console.log("[AnikotoTV] TMDB title: " + searchTitle);
                }
                return searchAnime(searchTitle);
            })
            .then(function(searchResults) {
                if (!searchResults || searchResults.length === 0) {
                    console.log("[AnikotoTV] No search results");
                    return resolve([]);
                }

                let bestMatch = searchResults[0];
                const queryLower = searchTitle.toLowerCase();
                for (let i = 0; i < searchResults.length; i++) {
                    const t = searchResults[i].title.toLowerCase();
                    if (t === queryLower || t.indexOf(queryLower) !== -1) {
                        bestMatch = searchResults[i];
                        break;
                    }
                }

                console.log("[AnikotoTV] Best match: " + bestMatch.title);
                return loadAnime(bestMatch.url);
            })
            .then(function(details) {
                if (!details || !details.episodes || details.episodes.length === 0) {
                    console.log("[AnikotoTV] No episodes");
                    return resolve([]);
                }

                const epNum = episode || 1;
                let targetEpisodes = details.episodes.filter(function(ep) {
                    return ep.number === epNum;
                });

                if (targetEpisodes.length === 0) {
                    const sorted = details.episodes.slice().sort(function(a, b) { return a.number - b.number; });
                    const idx = Math.min(Math.max(epNum - 1, 0), sorted.length - 1);
                    targetEpisodes = [sorted[idx]];
                }

                const streams = [];
                let pending = targetEpisodes.length;

                if (pending === 0) return resolve([]);

                function checkDone() {
                    pending--;
                    if (pending <= 0) {
                        console.log("[AnikotoTV] Returning " + streams.length + " streams");
                        resolve(streams);
                    }
                }

                targetEpisodes.forEach(function(ep) {
                    resolveEpisode(ep.url, function(link) {
                        streams.push({
                            name: "AnikotoTV",
                            title: (link.quality || "1080p") + " " + ep.type.toUpperCase(),
                            url: link.url,
                            quality: link.quality || "1080p",
                            headers: link.headers || {}
                        });
                    }).then(checkDone).catch(checkDone);
                });
            })
            .catch(function(err) {
                console.error("[AnikotoTV] Error:", err.message);
                resolve([]);
            });
    });
}

module.exports = { getStreams };
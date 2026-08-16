/**
 * AnikotoTV - Built from src/anikototv/
 * Anime streams from anikototv.to with MegaPlay/Vidtube/Vidwish support
 */
"use strict";

const cheerio = require("cheerio-without-node-native");

// ============================================
// Configuration
// ============================================

const CONFIG = {
    BASE_URL: "https://anikototv.to",
    TMDB_API_KEY: "439c478a771f35c05022f9feabcca01c",
    TMDB_BASE: "https://api.themoviedb.org/3",
    USER_AGENT: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    TIMEOUT: 30000
};

// ============================================
// HTTP Helpers
// ============================================

function getHeaders(extra = {}) {
    return {
        "User-Agent": CONFIG.USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        ...extra
    };
}

function getAjaxHeaders(referer) {
    return {
        "User-Agent": CONFIG.USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Referer": referer,
        "Accept-Language": "en-US,en;q=0.5"
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
// TMDB Integration
// ============================================

function getTMDBDetails(id, mediaType, season, episode) {
    return new Promise((resolve, reject) => {
        try {
            const type = (mediaType === "tv" || mediaType === "series") ? "tv" : "movie";
            let url = `${CONFIG.TMDB_BASE}/${type}/${id}?api_key=${CONFIG.TMDB_API_KEY}&language=en-US`;
            
            if (String(id).startsWith("tt")) {
                url = `${CONFIG.TMDB_BASE}/find/${id}?external_source=imdb_id&api_key=${CONFIG.TMDB_API_KEY}`;
            }
            
            fetchWithTimeout(url)
                .then(response => {
                    if (!response.ok) return resolve(null);
                    return response.json();
                })
                .then(data => {
                    if (!data) return resolve(null);
                    
                    let result = data;
                    if (String(id).startsWith("tt")) {
                        const results = type === "tv" ? data.tv_results : data.movie_results;
                        result = results && results[0] ? results[0] : null;
                        if (!result) return resolve(null);
                    }
                    
                    const title = type === "tv" ? result.name : result.title;
                    const releaseDate = result.release_date || result.first_air_date || "";
                    const year = releaseDate ? releaseDate.split("-")[0] : "2026";
                    
                    let epTitle = episode ? `Episode ${episode}` : null;
                    let duration = "24 min";
                    
                    if (type === "tv" && result.id && season && episode) {
                        const epUrl = `${CONFIG.TMDB_BASE}/tv/${result.id}/season/${season}/episode/${episode}?api_key=${CONFIG.TMDB_API_KEY}`;
                        fetchWithTimeout(epUrl)
                            .then(epResponse => {
                                if (epResponse.ok) return epResponse.json();
                                return null;
                            })
                            .then(epData => {
                                if (epData) {
                                    if (epData.name) epTitle = epData.name;
                                    if (epData.runtime) duration = `${epData.runtime} min`;
                                }
                                resolve({ title, year, epTitle, duration, id: result.id, type });
                            })
                            .catch(() => resolve({ title, year, epTitle, duration, id: result.id, type }));
                        return;
                    }
                    
                    if (type === "movie" && result.runtime) {
                        duration = `${result.runtime} min`;
                    }
                    
                    resolve({ title, year, epTitle, duration, id: result.id, type });
                })
                .catch(() => resolve(null));
        } catch (error) {
            resolve(null);
        }
    });
}

// ============================================
// Extractor: MegaPlay (Base)
// ============================================

function extractMegaPlay(url, referer, domain, subtitleCallback, callback) {
    return new Promise((resolve) => {
        try {
            const headers = getHeaders({ "Referer": referer || `https://${domain}/` });
            const baseUrl = `https://${domain}`;
            
            fetchWithTimeout(url, { headers })
                .then(response => {
                    if (!response.ok) return resolve(false);
                    return response.text();
                })
                .then(html => {
                    if (!html) return resolve(false);
                    
                    let dataIdMatch = html.match(/data-id="(\d+)"/);
                    
                    if (!dataIdMatch) {
                        const iframeMatch = html.match(/<iframe[^>]*src="([^"]+)"/);
                        if (iframeMatch) {
                            const iframeUrl = iframeMatch[1].startsWith("https://") 
                                ? iframeMatch[1] 
                                : `https://${domain}${iframeMatch[1]}`;
                            fetchWithTimeout(iframeUrl, { headers })
                                .then(iframeResponse => {
                                    if (iframeResponse.ok) return iframeResponse.text();
                                    return null;
                                })
                                .then(iframeHtml => {
                                    if (iframeHtml) {
                                        dataIdMatch = iframeHtml.match(/data-id="(\d+)"/);
                                    }
                                    if (!dataIdMatch) return resolve(false);
                                    return fetchSources(dataIdMatch[1], baseUrl, url, domain, referer, subtitleCallback, callback, resolve);
                                })
                                .catch(() => resolve(false));
                            return;
                        }
                        return resolve(false);
                    }
                    
                    fetchSources(dataIdMatch[1], baseUrl, url, domain, referer, subtitleCallback, callback, resolve);
                })
                .catch(() => resolve(false));
        } catch (error) {
            resolve(false);
        }
    });
}

function fetchSources(dataId, baseUrl, url, domain, referer, subtitleCallback, callback, resolve) {
    const sourcesUrl = `${baseUrl}/stream/getSources?id=${dataId}`;
    fetchWithTimeout(sourcesUrl, {
        headers: { ...getAjaxHeaders(url), "Referer": url }
    })
        .then(response => {
            if (!response.ok) return resolve(false);
            return response.json();
        })
        .then(sourcesData => {
            if (!sourcesData) return resolve(false);
            
            let videoUrl = null;
            if (sourcesData.sources) {
                if (typeof sourcesData.sources === "object" && sourcesData.sources.file) {
                    videoUrl = sourcesData.sources.file;
                } else if (Array.isArray(sourcesData.sources) && sourcesData.sources.length > 0) {
                    videoUrl = sourcesData.sources[0].file;
                }
            }
            
            if (!videoUrl) return resolve(false);
            
            if (sourcesData.tracks && subtitleCallback) {
                for (const track of sourcesData.tracks) {
                    if (track.kind === "captions" || track.kind === "subtitles") {
                        subtitleCallback({
                            url: track.file,
                            lang: track.label || track.language || "English",
                            label: track.label || "English"
                        });
                    }
                }
            }
            
            let quality = "1080p";
            fetchWithTimeout(videoUrl, { headers: { "Referer": `${baseUrl}/` } })
                .then(m3u8Response => {
                    if (m3u8Response.ok) return m3u8Response.text();
                    return null;
                })
                .then(m3u8 => {
                    if (m3u8) {
                        const resMatch = m3u8.match(/RESOLUTION=\d+x(\d+)/);
                        if (resMatch) quality = `${resMatch[1]}p`;
                    }
                    callback({
                        url: videoUrl,
                        quality: quality,
                        isM3U8: videoUrl.includes(".m3u8"),
                        headers: { "Referer": `${baseUrl}/`, "Origin": baseUrl }
                    });
                    resolve(true);
                })
                .catch(() => {
                    callback({
                        url: videoUrl,
                        quality: quality,
                        isM3U8: videoUrl.includes(".m3u8"),
                        headers: { "Referer": `${baseUrl}/`, "Origin": baseUrl }
                    });
                    resolve(true);
                });
        })
        .catch(() => resolve(false));
}

// ============================================
// AnikotoTV Core Functions
// ============================================

function getEpisodes(animeId, referer) {
    return new Promise((resolve) => {
        try {
            const url = `${CONFIG.BASE_URL}/ajax/episode/list/${animeId}`;
            fetchWithTimeout(url, { headers: getAjaxHeaders(referer) })
                .then(response => {
                    if (!response.ok) return resolve([]);
                    return response.text();
                })
                .then(jsonText => {
                    const html = jsonResultString(jsonText);
                    if (!html) return resolve([]);
                    
                    const episodes = [];
                    const $ = cheerio.load(html);
                    
                    $("a[data-ids]").each((i, el) => {
                        const $el = $(el);
                        const serverIds = $el.attr("data-ids");
                        const num = $el.attr("data-num");
                        const hasSub = $el.attr("data-sub") === "1";
                        const hasDub = $el.attr("data-dub") === "1";
                        
                        let name = `Episode ${num || "?"}`;
                        const nameEl = $el.find(".d-title");
                        if (nameEl.length) {
                            name = nameEl.text().trim() || name;
                        } else {
                            const jpName = $el.attr("data-jp");
                            if (jpName) name = jpName;
                        }
                        
                        if (serverIds) {
                            if (hasSub) {
                                episodes.push({
                                    name: name,
                                    url: `anikoto|${referer}|${serverIds}|sub`,
                                    number: parseInt(num) || 0,
                                    type: "sub"
                                });
                            }
                            if (hasDub) {
                                episodes.push({
                                    name: name + " (Dub)",
                                    url: `anikoto|${referer}|${serverIds}|dub`,
                                    number: parseInt(num) || 0,
                                    type: "dub"
                                });
                            }
                        }
                    });
                    
                    resolve(episodes);
                })
                .catch(() => resolve([]));
        } catch (error) {
            resolve([]);
        }
    });
}

function resolveEpisode(data, subtitleCallback, callback) {
    return new Promise((resolve) => {
        try {
            if (data.startsWith("anikoto-direct|")) {
                const episodeUrl = data.replace("anikoto-direct|", "");
                resolveFromWatchPage(episodeUrl, subtitleCallback, callback)
                    .then(resolve)
                    .catch(() => resolve(false));
                return;
            }
            
            const parts = data.split("|");
            if (parts.length < 4) return resolve(false);
            
            const referer = parts[1];
            const serverIds = parts[2];
            const audioType = parts[3] || "sub";
            
            const serverListUrl = `${CONFIG.BASE_URL}/ajax/server/list?servers=${serverIds}`;
            fetchWithTimeout(serverListUrl, { headers: getAjaxHeaders(referer) })
                .then(response => {
                    if (!response.ok) return resolve(false);
                    return response.text();
                })
                .then(serverJson => {
                    const serverHtml = jsonResultString(serverJson);
                    if (!serverHtml) return resolve(false);
                    
                    const $ = cheerio.load(serverHtml);
                    let linkIds = [];
                    
                    const typeSelector = audioType === "dub" ? 'div.type[data-type="dub"]' : 'div.type[data-type="sub"], div.type[data-type="hsub"]';
                    const typeEl = $(typeSelector);
                    const serverSection = typeEl.length ? typeEl.html() : serverHtml;
                    
                    const $section = cheerio.load(serverSection || serverHtml);
                    $section("li[data-link-id]").each((i, el) => {
                        const linkId = $(el).attr("data-link-id");
                        if (linkId && !linkIds.includes(linkId)) {
                            linkIds.push(linkId);
                        }
                    });
                    
                    if (linkIds.length === 0) {
                        $("li[data-link-id]").each((i, el) => {
                            const linkId = $(el).attr("data-link-id");
                            if (linkId && !linkIds.includes(linkId)) {
                                linkIds.push(linkId);
                            }
                        });
                    }
                    
                    if (linkIds.length === 0) return resolve(false);
                    
                    let found = false;
                    let processed = 0;
                    
                    for (const linkId of linkIds) {
                        const serverUrl = `${CONFIG.BASE_URL}/ajax/server?get=${linkId}`;
                        fetchWithTimeout(serverUrl, { headers: getAjaxHeaders(referer) })
                            .then(sResponse => {
                                if (!sResponse.ok) {
                                    processed++;
                                    if (processed >= linkIds.length && !found) resolve(false);
                                    return;
                                }
                                return sResponse.text();
                            })
                            .then(sJson => {
                                if (!sJson) {
                                    processed++;
                                    if (processed >= linkIds.length && !found) resolve(false);
                                    return;
                                }
                                const embedUrl = jsonResultUrl(sJson);
                                if (!embedUrl) {
                                    processed++;
                                    if (processed >= linkIds.length && !found) resolve(false);
                                    return;
                                }
                                
                                const domains = [
                                    { domain: "megaplay.buzz", name: "MegaPlay" },
                                    { domain: "vidtube.site", name: "Vidtube" },
                                    { domain: "vidwish.live", name: "Vidwish" }
                                ];
                                
                                let resolved = false;
                                for (const d of domains) {
                                    if (embedUrl.includes(d.domain)) {
                                        extractMegaPlay(embedUrl, referer, d.domain, subtitleCallback, callback)
                                            .then(result => {
                                                if (result) {
                                                    found = true;
                                                    resolve(true);
                                                } else {
                                                    processed++;
                                                    if (processed >= linkIds.length && !found) resolve(false);
                                                }
                                            });
                                        resolved = true;
                                        break;
                                    }
                                }
                                
                                if (!resolved) {
                                    processed++;
                                    if (processed >= linkIds.length && !found) resolve(false);
                                }
                            })
                            .catch(() => {
                                processed++;
                                if (processed >= linkIds.length && !found) resolve(false);
                            });
                    }
                    
                    // If no linkIds were processed
                    if (linkIds.length === 0) resolve(false);
                })
                .catch(() => resolve(false));
        } catch (error) {
            resolve(false);
        }
    });
}

function resolveFromWatchPage(episodeUrl, subtitleCallback, callback) {
    return new Promise((resolve) => {
        try {
            fetchWithTimeout(episodeUrl, { headers: getHeaders() })
                .then(response => {
                    if (!response.ok) return resolve(false);
                    return response.text();
                })
                .then(html => {
                    const idMatch = html.match(/data-id="(\d+)"/);
                    if (!idMatch) return resolve(false);
                    
                    const animeId = idMatch[1];
                    getEpisodes(animeId, episodeUrl)
                        .then(episodes => {
                            let episodeData = null;
                            const epNumMatch = episodeUrl.match(/\/ep-(\d+)/);
                            if (epNumMatch) {
                                const epNum = parseInt(epNumMatch[1]);
                                for (const ep of episodes) {
                                    if (ep.number === epNum) {
                                        episodeData = ep;
                                        break;
                                    }
                                }
                            }
                            if (!episodeData) return resolve(false);
                            resolveEpisode(episodeData.url, subtitleCallback, callback)
                                .then(resolve)
                                .catch(() => resolve(false));
                        })
                        .catch(() => resolve(false));
                })
                .catch(() => resolve(false));
        } catch (error) {
            resolve(false);
        }
    });
}

function searchAnime(query) {
    return new Promise((resolve) => {
        try {
            const url = `${CONFIG.BASE_URL}/filter?keyword=${encodeURIComponent(query)}`;
            fetchWithTimeout(url, { headers: getHeaders() })
                .then(response => {
                    if (!response.ok) return resolve([]);
                    return response.text();
                })
                .then(html => {
                    const $ = cheerio.load(html);
                    const results = [];
                    
                    $("div.item, div.flw-item").each((i, el) => {
                        const $el = $(el);
                        let titleEl = $el.find("a.d-title, a[title], a[href*='/watch/']").first();
                        if (!titleEl.length) return;
                        
                        const href = titleEl.attr("href");
                        const title = titleEl.text().trim();
                        
                        if (!href || !title) return;
                        
                        const cleanHref = href.replace(/\/ep-\d+$/, "");
                        const fullUrl = cleanHref.startsWith("http") ? cleanHref : `${CONFIG.BASE_URL}${cleanHref}`;
                        
                        let poster = null;
                        const posterEl = $el.find("div.poster img, img");
                        if (posterEl.length) {
                            poster = posterEl.attr("data-src") || posterEl.attr("src");
                            if (poster && poster.startsWith("//")) poster = "https:" + poster;
                            if (poster && poster.startsWith("/")) poster = CONFIG.BASE_URL + poster;
                        }
                        
                        let type = "tv";
                        const typeEl = $el.find(".fd-infor .tick-item.tick-type, .item-type, .tick-type, .type");
                        if (typeEl.length && typeEl.text().toLowerCase().includes("movie")) {
                            type = "movie";
                        }
                        
                        const hasDub = $el.find(".dub, i.dub, .fa-microphone").length > 0 || 
                                       $el.text().toLowerCase().includes("dub");
                        const hasSub = $el.find(".sub, i.sub, .fa-closed-captioning").length > 0 ||
                                       $el.text().toLowerCase().includes("sub");
                        
                        results.push({
                            title: title,
                            url: fullUrl,
                            posterUrl: poster,
                            type: type,
                            hasDub: hasDub,
                            hasSub: hasSub
                        });
                    });
                    
                    resolve(results);
                })
                .catch(() => resolve([]));
        } catch (error) {
            resolve([]);
        }
    });
}

// ============================================
// Main getStreams - Nuvio Entry Point
// ============================================

function getStreams(tmdbId, mediaType, season, episode) {
    return new Promise((resolve, reject) => {
        try {
            const log = (msg) => console.log(`[AnikotoTV] ${msg}`);
            log(`Fetching: ${tmdbId} (${mediaType}) S${season || "?"}E${episode || "?"}`);
            
            // Step 1: Resolve TMDB ID to title
            let searchTitle = String(tmdbId);
            
            getTMDBDetails(tmdbId, mediaType, season, episode)
                .then(tmdbInfo => {
                    if (tmdbInfo && tmdbInfo.title) {
                        searchTitle = tmdbInfo.title;
                        log(`TMDB resolved: ${searchTitle}`);
                    }
                    
                    // Step 2: Search AnikotoTV
                    return searchAnime(searchTitle);
                })
                .then(searchResults => {
                    if (!searchResults || searchResults.length === 0) {
                        log("No results found");
                        return resolve([]);
                    }
                    
                    // Step 3: Find best match
                    let bestMatch = searchResults[0];
                    const queryLower = searchTitle.toLowerCase();
                    for (const result of searchResults) {
                        if (result.title.toLowerCase() === queryLower) {
                            bestMatch = result;
                            break;
                        }
                        if (result.title.toLowerCase().includes(queryLower)) {
                            bestMatch = result;
                            break;
                        }
                    }
                    log(`Best match: ${bestMatch.title}`);
                    
                    // Step 4: Load anime details
                    return loadAnime(bestMatch.url);
                })
                .then(details => {
                    if (!details) {
                        log("Failed to load anime details");
                        return resolve([]);
                    }
                    
                    // Step 5: Find target episode
                    let targetEpisode = null;
                    if (mediaType === "movie") {
                        if (details.episodes && details.episodes.length > 0) {
                            targetEpisode = details.episodes[0];
                        } else {
                            targetEpisode = {
                                name: details.title || "Movie",
                                url: details.url || "",
                                number: 1,
                                type: "sub"
                            };
                        }
                    } else {
                        const epNum = episode || 1;
                        for (const ep of details.episodes || []) {
                            if (ep.number === epNum) {
                                targetEpisode = ep;
                                break;
                            }
                        }
                        if (!targetEpisode && details.episodes) {
                            const sorted = [...details.episodes].sort((a, b) => a.number - b.number);
                            const idx = Math.min(episode - 1, sorted.length - 1);
                            if (idx >= 0 && idx < sorted.length) {
                                targetEpisode = sorted[idx];
                            }
                        }
                    }
                    
                    if (!targetEpisode) {
                        log("Episode not found");
                        return resolve([]);
                    }
                    
                    log(`Target episode: ${targetEpisode.name} (${targetEpisode.type})`);
                    
                    // Step 6: Resolve to streams
                    const streams = [];
                    let found = false;
                    
                    const subtitleCallback = (subtitle) => {
                        // Subtitles handled if needed
                    };
                    
                    const callback = (link) => {
                        const stream = {
                            name: "AnikotoTV",
                            title: `${link.quality || "1080p"} ${targetEpisode.type === "dub" ? "DUB" : "SUB"}`,
                            url: link.url,
                            quality: link.quality || "1080p",
                            headers: link.headers || {}
                        };
                        streams.push(stream);
                        found = true;
                    };
                    
                    resolveEpisode(targetEpisode.url, subtitleCallback, callback)
                        .then(() => {
                            if (streams.length === 0) {
                                log("No streams found");
                            } else {
                                log(`Found ${streams.length} streams`);
                            }
                            resolve(streams);
                        })
                        .catch(() => resolve(streams));
                })
                .catch(error => {
                    console.error(`[AnikotoTV] Error: ${error.message}`);
                    resolve([]);
                });
        } catch (error) {
            console.error(`[AnikotoTV] getStreams error: ${error.message}`);
            resolve([]);
        }
    });
}

function loadAnime(url) {
    return new Promise((resolve) => {
        try {
            fetchWithTimeout(url, { headers: getHeaders() })
                .then(response => {
                    if (!response.ok) return resolve(null);
                    return response.text();
                })
                .then(html => {
                    const $ = cheerio.load(html);
                    
                    let title = $("h1.title, h1[itemprop=name]").first().text().trim();
                    if (!title) {
                        title = $("h1.title").first().text().trim();
                    }
                    if (!title) return resolve(null);
                    
                    let poster = null;
                    const posterEl = $("img[data-src], img[itemprop=image], .poster img").first();
                    if (posterEl.length) {
                        poster = posterEl.attr("data-src") || posterEl.attr("src");
                        if (poster && poster.startsWith("//")) poster = "https:" + poster;
                        if (poster && poster.startsWith("/")) poster = CONFIG.BASE_URL + poster;
                    }
                    
                    let description = "";
                    const descEl = $(".synopsis .content, .synopsis");
                    if (descEl.length) {
                        description = descEl.text().trim().replace(/\s+/g, " ");
                    }
                    
                    const genres = [];
                    $("a[href*='/genre/']").each((i, el) => {
                        const genre = $(el).text().trim();
                        if (genre) genres.push(genre);
                    });
                    
                    const isMovie = html.includes("/type/movie") || 
                                   (html.includes("Movie") && !html.includes("/type/tv"));
                    
                    let animeId = null;
                    const idEl = $("[data-id]").first();
                    if (idEl.length) {
                        animeId = idEl.attr("data-id");
                    }
                    
                    if (!animeId) {
                        const idMatch = html.match(/data-id=["'](\d+)["']/);
                        if (idMatch) animeId = idMatch[1];
                    }
                    
                    let episodes = [];
                    if (animeId) {
                        getEpisodes(animeId, url)
                            .then(eps => {
                                episodes = eps;
                                resolve({
                                    title: title,
                                    posterUrl: poster,
                                    description: description || "No description available",
                                    genres: genres,
                                    type: isMovie ? "movie" : "tv",
                                    episodes: episodes,
                                    animeId: animeId,
                                    url: url
                                });
                            })
                            .catch(() => {
                                resolve({
                                    title: title,
                                    posterUrl: poster,
                                    description: description || "No description available",
                                    genres: genres,
                                    type: isMovie ? "movie" : "tv",
                                    episodes: [],
                                    animeId: animeId,
                                    url: url
                                });
                            });
                        return;
                    }
                    
                    resolve({
                        title: title,
                        posterUrl: poster,
                        description: description || "No description available",
                        genres: genres,
                        type: isMovie ? "movie" : "tv",
                        episodes: [],
                        animeId: animeId,
                        url: url
                    });
                })
                .catch(() => resolve(null));
        } catch (error) {
            resolve(null);
        }
    });
}

// ============================================
// Nuvio Export
// ============================================

module.exports = { getStreams };
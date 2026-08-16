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
    BASE_URL: "https://anikototv.cz",
    TMDB_API_KEY: "439c478a771f35c05022f9feabcca01c",
    TMDB_BASE: "https://api.themoviedb.org/3",
    USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    TIMEOUT: 30000
};

function getHeaders(extra = {}) {
    return {
        "User-Agent": CONFIG.USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        ...extra
    };
}

function getAjaxHeaders(referer) {
    return {
        "User-Agent": CONFIG.USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Referer": referer || CONFIG.BASE_URL,
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
    return new Promise((resolve) => {
        try {
            const type = (mediaType === "tv" || mediaType === "series") ? "tv" : "movie";
            let url = `${CONFIG.TMDB_BASE}/${type}/${id}?api_key=${CONFIG.TMDB_API_KEY}&language=en-US`;
            
            if (String(id).startsWith("tt")) {
                url = `${CONFIG.TMDB_BASE}/find/${id}?external_source=imdb_id&api_key=${CONFIG.TMDB_API_KEY}`;
            }
            
            fetchWithTimeout(url)
                .then(response => response.ok ? response.json() : null)
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
                            .then(epResponse => epResponse.ok ? epResponse.json() : null)
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
                .then(response => response.ok ? response.text() : null)
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
                                .then(iframeResponse => iframeResponse.ok ? iframeResponse.text() : null)
                                .then(iframeHtml => {
                                    if (iframeHtml) {
                                        dataIdMatch = iframeHtml.match(/data-id="(\d+)"/);
                                    }
                                    if (!dataIdMatch) return resolve(false);
                                    fetchSources(dataIdMatch[1], baseUrl, url, domain, referer, subtitleCallback, callback, resolve);
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
        .then(response => response.ok ? response.json() : null)
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
                .then(m3u8Response => m3u8Response.ok ? m3u8Response.text() : null)
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
                .then(response => response.ok ? response.text() : null)
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
                .then(response => response.ok ? response.text() : null)
                .then(serverJson => {
                    const serverHtml = jsonResultString(serverJson);
                    if (!serverHtml) return resolve(false);
                    
                    const $ = cheerio.load(serverHtml);
                    let linkIds = [];
                    
                    // Try to find type-specific servers first
                    const typeSelector = audioType === "dub" ? 'div.type[data-type="dub"]' : 'div.type[data-type="sub"], div.type[data-type="hsub"]';
                    const typeEl = $(typeSelector);
                    
                    if (typeEl.length) {
                        typeEl.find("li[data-link-id]").each((i, el) => {
                            const linkId = $(el).attr("data-link-id");
                            if (linkId && !linkIds.includes(linkId)) linkIds.push(linkId);
                        });
                    }
                    
                    // If no type-specific servers, get all
                    if (linkIds.length === 0) {
                        $("li[data-link-id]").each((i, el) => {
                            const linkId = $(el).attr("data-link-id");
                            if (linkId && !linkIds.includes(linkId)) linkIds.push(linkId);
                        });
                    }
                    
                    if (linkIds.length === 0) return resolve(false);
                    
                    let found = false;
                    let processed = 0;
                    
                    for (const linkId of linkIds) {
                        const serverUrl = `${CONFIG.BASE_URL}/ajax/server?get=${linkId}`;
                        fetchWithTimeout(serverUrl, { headers: getAjaxHeaders(referer) })
                            .then(sResponse => sResponse.ok ? sResponse.text() : null)
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
                .then(response => response.ok ? response.text() : null)
                .then(html => {
                    if (!html) return resolve(false);
                    
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

// ============================================
// Search - UPDATED with better selectors
// ============================================

function searchAnime(query) {
    return new Promise((resolve) => {
        try {
            const url = `${CONFIG.BASE_URL}/filter?keyword=${encodeURIComponent(query)}`;
            console.log(`[AnikotoTV] Searching: ${url}`);
            
            fetchWithTimeout(url, { headers: getHeaders() })
                .then(response => {
                    console.log(`[AnikotoTV] Search response: ${response.status}`);
                    if (!response.ok) return resolve([]);
                    return response.text();
                })
                .then(html => {
                    if (!html) {
                        console.log('[AnikotoTV] Empty HTML response');
                        return resolve([]);
                    }
                    
                    console.log(`[AnikotoTV] HTML length: ${html.length}`);
                    
                    const $ = cheerio.load(html);
                    const results = [];
                    
                    // Try multiple selectors
                    let items = [];
                    
                    // Try common selectors
                    const selectors = [
                        'div.item',
                        'div.flw-item',
                        '.item',
                        '.flw-item',
                        'div[class*="item"]',
                        'article',
                        'li[class*="item"]'
                    ];
                    
                    for (const selector of selectors) {
                        const found = $(selector);
                        if (found.length > 0) {
                            items = found;
                            console.log(`[AnikotoTV] Found ${items.length} items with selector: ${selector}`);
                            break;
                        }
                    }
                    
                    // If no items found, try to find any link to /watch/
                    if (items.length === 0) {
                        console.log('[AnikotoTV] No items found, trying links...');
                        const links = $('a[href*="/watch/"]');
                        console.log(`[AnikotoTV] Found ${links.length} watch links`);
                        
                        // Create items from links
                        links.each((i, el) => {
                            const $el = $(el);
                            const href = $el.attr('href');
                            const text = $el.text().trim();
                            
                            if (href && text) {
                                // Find parent container
                                let parent = $el.parent();
                                for (let j = 0; j < 3; j++) {
                                    if (parent.hasClass('item') || parent.hasClass('flw-item') || parent.attr('class')?.includes('item')) {
                                        break;
                                    }
                                    parent = parent.parent();
                                }
                                
                                results.push({
                                    title: text,
                                    url: href.startsWith('http') ? href : `${CONFIG.BASE_URL}${href}`,
                                    posterUrl: null,
                                    type: 'tv',
                                    hasDub: false,
                                    hasSub: true
                                });
                            }
                        });
                        
                        resolve(results);
                        return;
                    }
                    
                    // Parse items
                    items.each((i, el) => {
                        const $el = $(el);
                        
                        // Find title and link
                        let titleEl = $el.find('a.d-title, a[title], a[href*="/watch/"]').first();
                        if (!titleEl.length) {
                            titleEl = $el.find('a').filter((i2, el2) => {
                                const href = $(el2).attr('href');
                                return href && href.includes('/watch/');
                            }).first();
                        }
                        
                        if (!titleEl.length) {
                            // Try any link with text
                            titleEl = $el.find('a').first();
                            if (!titleEl.length || !titleEl.text().trim()) return;
                        }
                        
                        const href = titleEl.attr('href');
                        const title = titleEl.text().trim() || 'Unknown';
                        
                        if (!href) return;
                        
                        const fullUrl = href.startsWith('http') ? href : `${CONFIG.BASE_URL}${href}`;
                        
                        // Find poster
                        let poster = null;
                        const posterEl = $el.find('img[data-src], img[src]').first();
                        if (posterEl.length) {
                            poster = posterEl.attr('data-src') || posterEl.attr('src');
                            if (poster && poster.startsWith('//')) poster = 'https:' + poster;
                            if (poster && poster.startsWith('/')) poster = CONFIG.BASE_URL + poster;
                        }
                        
                        // Determine type
                        let type = 'tv';
                        const typeText = $el.text().toLowerCase();
                        if (typeText.includes('movie') || typeText.includes('film')) {
                            type = 'movie';
                        }
                        
                        // Check dub/sub
                        const hasDub = typeText.includes('dub');
                        const hasSub = typeText.includes('sub') || !hasDub;
                        
                        results.push({
                            title: title,
                            url: fullUrl,
                            posterUrl: poster,
                            type: type,
                            hasDub: hasDub,
                            hasSub: hasSub
                        });
                    });
                    
                    console.log(`[AnikotoTV] Found ${results.length} results`);
                    resolve(results);
                })
                .catch(error => {
                    console.error('[AnikotoTV] Search error:', error.message);
                    resolve([]);
                });
        } catch (error) {
            console.error('[AnikotoTV] Search error:', error.message);
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
            
            let searchTitle = String(tmdbId);
            
            getTMDBDetails(tmdbId, mediaType, season, episode)
                .then(tmdbInfo => {
                    if (tmdbInfo && tmdbInfo.title) {
                        searchTitle = tmdbInfo.title;
                        log(`TMDB resolved: ${searchTitle}`);
                    }
                    return searchAnime(searchTitle);
                })
                .then(searchResults => {
                    if (!searchResults || searchResults.length === 0) {
                        log("No results found");
                        return resolve([]);
                    }
                    
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
                    
                    // Load anime details
                    return loadAnime(bestMatch.url);
                })
                .then(details => {
                    if (!details) {
                        log("Failed to load anime details");
                        return resolve([]);
                    }
                    
                    // Find target episode
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
                    
                    const streams = [];
                    
                    const callback = (link) => {
                        const stream = {
                            name: "AnikotoTV",
                            title: `${link.quality || "1080p"} ${targetEpisode.type === "dub" ? "DUB" : "SUB"}`,
                            url: link.url,
                            quality: link.quality || "1080p",
                            headers: link.headers || {}
                        };
                        streams.push(stream);
                    };
                    
                    resolveEpisode(targetEpisode.url, null, callback)
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
                .then(response => response.ok ? response.text() : null)
                .then(html => {
                    if (!html) return resolve(null);
                    
                    const $ = cheerio.load(html);
                    
                    let title = $("h1.title, h1[itemprop=name]").first().text().trim();
                    if (!title) {
                        title = $("h1").first().text().trim();
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

module.exports = { getStreams };
// -----------------------------
// CLIPART SEARCH MODULE (NODE)
// -----------------------------

// If using Node < 18, uncomment below:
// const fetch = require("node-fetch");

async function fetchFromOpenverse(query) {
    try {
        const url = `https://api.openverse.engineering/v1/images?q=${encodeURIComponent(query)}&license=cc0`;

        const res = await fetch(url);
        console.log("[Openverse STATUS]", res.status);

        const data = await res.json();

        if (data.results && data.results.length > 0) {
            console.log("[Openverse HIT]");
            return data.results[0].url;
        }

    } catch (e) {
        console.error("[Openverse ERROR]", e.message);
    }

    return null;
}

async function fetchFromPixabay(query) {
    try {
        const API_KEY = "55451316-0bea46e5eff16ea50bbfc626b";

        const url = `https://pixabay.com/api/?key=${API_KEY}&q=${encodeURIComponent(query)}+whitebackground+&image_type=illustration`;

        const res = await fetch(url);
        const data = await res.json();

        if (data.hits && data.hits.length > 0) {
            console.log("[Pixabay HIT]");
            return data.hits[0].webformatURL;
        }

    } catch (e) {
        console.error("[Pixabay ERROR]", e.message);
    }

    return null;
}

// MAIN SEARCH FUNCTION
async function searchClipart(word) {
    const query = word
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .trim();

    const smartQuery = `${query} outline simple`;

    console.log("\n[SEARCH]", smartQuery);

    let url;

    // 1. Openverse
    url = await fetchFromOpenverse(smartQuery);
    if (url) return url;

    // 2. Pixabay (strong fallback)
    url = await fetchFromPixabay(smartQuery);
    if (url) return url;

    // 3. Final fallback
    return `https://dummyimage.com/400x400/000/fff&text=${encodeURIComponent(query)}`;
}

// -----------------------------
// TEST RUN
// -----------------------------
(async () => {
    // const testWords = ["nail", "dog", "car", "tree"];

    // for (const word of testWords) {
    //     await searchClipart(word);
    // }
    await searchClipart("dog");
    
})();
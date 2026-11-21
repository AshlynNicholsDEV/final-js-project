// Page controls

const form = document.querySelector("#search-form");
const input = document.querySelector("#query");
const sort = document.querySelector("#sort");
const grid = document.querySelector("#movies");
const status = document.querySelector("#status");
const spinner = document.querySelector("#spinner");
const retry = document.querySelector("#retry");
const pagination = document.querySelector("#pagination");
const previousPage = document.querySelector("#previous-page");
const nextPage = document.querySelector("#next-page");
const pageLabel = document.querySelector("#page-label");
const filmTemplate = document.querySelector("#film-card");
// Sorting and search state

const collator = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true,
});

const byTitle = (a, b) => collator.compare(a.title, b.title);
const compareYears = (direction) => (a, b) => {
  if (a.year === null) return b.year === null ? byTitle(a, b) : 1;
  if (b.year === null) return -1;
  return direction * (a.year - b.year) || byTitle(a, b);
};
const comparators = {
  newest: compareYears(-1),
  oldest: compareYears(1),
  asc: byTitle,
  desc: (a, b) => byTitle(b, a),
};

const apiKey = globalThis.omdbLocalKey ?? "";
let request;
let results = [];
let searchTimer;
let loadedPage = 0;
let loadedQuery = "";
let resultsStatus = "";
let totalPages = 0;
let retrySearch;

// Results and movie cards

function render() {
  const movies = [...results];
  const compare = comparators[sort.value];

  if (compare) {
    movies.sort(compare);
  }

  grid.replaceChildren(...movies.map(createMovieCard));
}

function createMovieCard(movie) {
  const card = filmTemplate.content.cloneNode(true);
  const poster = card.querySelector("img");
  const title = card.querySelector("h3");
  const year = card.querySelector("time");
  const link = card.querySelector("a");

  if (movie.poster) {
    poster.hidden = false;
    poster.addEventListener(
      "error",
      () => {
        poster.hidden = true;
      },
      { once: true },
    );
    poster.src = movie.poster;
  }

  title.textContent = movie.title;
  if (movie.year === null) {
    year.remove();
  } else {
    year.textContent = movie.year;
    year.dateTime = String(movie.year);
  }

  if (movie.imdbId) {
    link.href = `https://www.imdb.com/title/${movie.imdbId}/`;
  } else {
    const article = movie.title.replaceAll(" ", "_");
    link.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(article)}`;
  }

  return card;
}

//

class MovieSearchError extends Error {}

async function getMovies(parameters, signal) {
  const params = new URLSearchParams({
    apikey: apiKey,
    type: "movie",
    ...parameters,
  });
  let response;
  try {
    response = await fetch(`https://www.omdbapi.com/?${params}`, { signal });
  } catch {
    if (signal.reason?.name === "TimeoutError") {
      throw new MovieSearchError("OMDb took too long to respond. Try again.");
    }
    throw new MovieSearchError("Couldn’t reach OMDb. Check your internet connection and try again.");
  }

  const data = await response.json();
  const error = data.Error ?? "";
  if (/^Movie not found!?$/i.test(error)) return null;
  if (/invalid api key|no api key/i.test(error)) {
    throw new MovieSearchError("OMDb rejected the API key. Check the key in omdb.local.js.");
  }
  if (response.status === 429 || /request limit/i.test(error)) {
    throw new MovieSearchError("The OMDb request limit was reached. Try again later.");
  }
  if (/^too many results\.?$/i.test(error)) {
    throw new MovieSearchError("Too many movies matched. Enter a more specific title.");
  }
  if (!response.ok || data.Response !== "True") {
    throw new MovieSearchError("OMDb couldn’t complete the search. Try again.");
  }
  return data;
}

function toMovie(data) {
  const year = Number.parseInt(data.Year, 10);
  return {
    title: data.Title,
    year: Number.isFinite(year) && year > 0 ? year : null,
    poster: /^https:\/\//i.test(data.Poster ?? "") ? data.Poster : null,
    imdbId: /^tt\d+$/.test(data.imdbID ?? "") ? data.imdbID : null,
  };
}

// Live search

const moviesPerPage = 10;
const maxOmdbPages = 100;

const loadingGrid = document.querySelector("#loading-movies");
const skeletonTemplate = document.querySelector("#movie-skeleton");
loadingGrid.replaceChildren(
  ...Array.from({ length: moviesPerPage }, () =>
    skeletonTemplate.content.cloneNode(true),
  ),
);

function setLoading(isLoading) {
  spinner.hidden = !isLoading;
  loadingGrid.hidden = !isLoading;
  grid.hidden = isLoading;
  grid.setAttribute("aria-busy", String(isLoading));
}

function showPagination(totalPages, busy = false) {
  pagination.hidden = totalPages <= 1;
  pageLabel.textContent = `Page ${loadedPage} of ${totalPages}`;
  previousPage.disabled = busy || loadedPage <= 1;
  nextPage.disabled = busy || loadedPage >= totalPages;
}

async function searchMovies(page = 1, newSearch = true) {
  clearTimeout(searchTimer);
  request?.abort();

  request = undefined;
  const query = newSearch ? input.value.trim() : loadedQuery;
  retry.hidden = true;

  if (!apiKey || !query || (newSearch && query === loadedQuery)) {
    setLoading(false);
    showPagination(totalPages);
    status.textContent = apiKey
      ? resultsStatus || "Enter a movie title to search OMDb."
      : "Movie search is unavailable because the OMDb API key is missing.";
    return;
  }

  const current = new AbortController();
  request = current;
  showPagination(totalPages, true);

  setLoading(true);
  status.textContent = `Fetching page ${page} for “${query}”…`;

  try {
    const signal = AbortSignal.any([
      current.signal,
      AbortSignal.timeout(15000),
    ]);

    const [response] = await Promise.allSettled([
      getMovies({ s: query, page: String(page) }, signal),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);

    if (current !== request) return;
    if (response.status === "rejected") throw response.reason;
    const data = response.value;

    if (!data?.Search?.length) {
      if (newSearch) {
        results = [];
        loadedQuery = "";
        resultsStatus = "";
        loadedPage = 0;
        totalPages = 0;
        render();
      }
      status.textContent = newSearch
        ? `No movies found for “${query}”. Try another title.`
        : `Page ${page} has no available movies for “${query}”.`;
      if (!newSearch && page > loadedPage) totalPages = loadedPage;
      return;
    }

    results = data.Search.slice(0, moviesPerPage).map(toMovie);
    loadedPage = page;
    loadedQuery = query;
    const totalResults = Number(data.totalResults) || results.length;
    totalPages = Math.min(
      maxOmdbPages,
      Math.ceil(totalResults / moviesPerPage),
    );
    render();

    const firstResult = (page - 1) * moviesPerPage + 1;
    const lastResult = firstResult + results.length - 1;
    resultsStatus = `Showing ${firstResult}–${lastResult} of ${totalResults} movies for “${query}”.`;
    status.textContent = resultsStatus;
  } catch (error) {
    if (current !== request) return;
    retrySearch = () => searchMovies(page, newSearch);
    status.textContent = error instanceof MovieSearchError
      ? error.message
      : "Couldn’t load movie results. Try again.";
    retry.hidden = false;
  } finally {
    if (current === request) {
      setLoading(false);
      showPagination(totalPages);
    }
  }
}

// Event handlers and startup

form.addEventListener("submit", (event) => {
  event.preventDefault();
  searchMovies();
});

input.addEventListener("input", () => {
  if (!input.value.trim()) {
    searchMovies();
    return;
  }

  clearTimeout(searchTimer);
  request?.abort();
  request = undefined;
  pagination.hidden = true;
  retry.hidden = true;
  searchTimer = setTimeout(searchMovies, 350);
});

sort.addEventListener("change", render);
retry.addEventListener("click", () => retrySearch?.());
previousPage.addEventListener("click", () =>
  searchMovies(loadedPage - 1, false),
);
nextPage.addEventListener("click", () => searchMovies(loadedPage + 1, false));

if (apiKey && !input.value.trim()) input.value = "Avengers";
searchMovies();

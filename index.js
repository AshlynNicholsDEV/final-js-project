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

let request;
let results = [];
let searchTimer;
let loadedPage = 0;
let loadedQuery = "";
let resultsStatus = "";
let hasNextPage = false;
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

  link.href = movie.articleUrl;

  return card;
}

// Wikipedia movie search and result mapping

class MovieSearchError extends Error {}

async function getMovies(query, page, signal) {
  // Restrict title matches to articles that use Wikipedia's film infobox.
  const words = query.replace(/[^\p{L}\p{N}\p{M} -]+/gu, " ").trim();
  if (!words) return { movies: [], hasNextPage: false };

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    origin: "*",
    generator: "search",
    gsrnamespace: "0",
    gsrlimit: String(moviesPerPage),
    gsroffset: String((page - 1) * moviesPerPage),
    gsrsearch: `intitle:"${words}" hastemplate:"Infobox film"`,
    prop: "pageimages|description|extracts",
    piprop: "thumbnail",
    pithumbsize: "400",
    pilicense: "any",
    pilimit: String(moviesPerPage),
    exintro: "1",
    explaintext: "1",
    exsentences: "1",
    exlimit: String(moviesPerPage),
  });

  try {
    const response = await fetch(
      `https://en.wikipedia.org/w/api.php?${params}`,
      { signal },
    );
    if (response.status === 429)
      throw new MovieSearchError(
        "The movie search is busy. Try again shortly.",
      );
    if (!response.ok)
      throw new MovieSearchError(
        "Wikipedia couldn’t complete the search. Try again.",
      );
    const data = await response.json();
    if (data.error)
      throw new MovieSearchError(
        "Wikipedia couldn’t complete the search. Try again.",
      );

    const movies = (data.query?.pages ?? [])
      .sort((a, b) => a.index - b.index)
      .slice(0, moviesPerPage)
      .map(toMovie);
    return { movies, hasNextPage: Number.isInteger(data.continue?.gsroffset) };
  } catch (error) {
    if (error instanceof MovieSearchError) throw error;
    if (signal.reason?.name === "TimeoutError") {
      throw new MovieSearchError("The movie search took too long. Try again.");
    }
    throw new MovieSearchError(
      "Couldn’t reach Wikipedia. Check your connection and try again.",
    );
  }
}

function toMovie(page) {
  const filmSuffix = /\s+\((?:(\d{4})\s+|[^()]+?\s+)?films?\)$/i;
  const title = page.title.replace(filmSuffix, "");
  const year =
    page.title.match(filmSuffix)?.[1] ??
    page.description?.match(/^(\d{4})\b/)?.[1] ??
    page.extract?.match(/\bis an? (\d{4})\b/i)?.[1];

  return {
    title,
    year: year ? Number(year) : null,
    poster: /^https:\/\/upload\.wikimedia\.org\//i.test(
      page.thumbnail?.source ?? "",
    )
      ? page.thumbnail.source
      : null,
    articleUrl: `https://en.wikipedia.org/?curid=${page.pageid}`,
  };
}

// Live search

const moviesPerPage = 10;

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

function showPagination(busy = false) {
  pagination.hidden = loadedPage <= 1 && !hasNextPage;
  pageLabel.textContent = `Page ${loadedPage}`;
  previousPage.disabled = busy || loadedPage <= 1;
  nextPage.disabled = busy || !hasNextPage;
}

async function searchMovies(page = 1, newSearch = true) {
  clearTimeout(searchTimer);
  request?.abort();

  request = undefined;
  const query = newSearch ? input.value.trim() : loadedQuery;
  retry.hidden = true;

  if (!query || (newSearch && query === loadedQuery)) {
    setLoading(false);
    showPagination();
    status.textContent = resultsStatus || "Enter a movie title to search.";
    return;
  }

  const current = new AbortController();
  request = current;
  showPagination(true);

  setLoading(true);
  status.textContent = `Fetching page ${page} for “${query}”…`;

  try {
    const signal = AbortSignal.any([
      current.signal,
      AbortSignal.timeout(15000),
    ]);

    const [response] = await Promise.allSettled([
      getMovies(query, page, signal),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);

    if (current !== request) return;
    if (response.status === "rejected") throw response.reason;
    const data = response.value;

    if (!data.movies.length) {
      if (newSearch) {
        results = [];
        loadedQuery = "";
        resultsStatus = "";
        loadedPage = 0;
        hasNextPage = false;
        render();
      }
      status.textContent = newSearch
        ? `No movies found for “${query}”. Try another title.`
        : `Page ${page} has no available movies for “${query}”.`;
      if (!newSearch && page > loadedPage) hasNextPage = false;
      return;
    }

    results = data.movies;
    loadedPage = page;
    loadedQuery = query;
    hasNextPage = data.hasNextPage;
    render();

    const firstResult = (page - 1) * moviesPerPage + 1;
    const lastResult = firstResult + results.length - 1;
    resultsStatus = `Showing ${firstResult}–${lastResult} movies for “${query}”.`;
    status.textContent = resultsStatus;
  } catch (error) {
    if (current !== request) return;
    retrySearch = () => searchMovies(page, newSearch);
    status.textContent =
      error instanceof MovieSearchError
        ? error.message
        : "Couldn’t load movie results. Try again.";
    retry.hidden = false;
  } finally {
    if (current === request) {
      setLoading(false);
      showPagination();
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

if (!input.value.trim()) input.value = "Avengers";
searchMovies();

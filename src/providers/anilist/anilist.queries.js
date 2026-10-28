/**
 * AniList GraphQL query definitions.
 *
 * Kept separate from the provider class so the provider stays focused on
 * execution/error mapping. Queries request ONLY the fields the application
 * actually needs (Phase 2 spec: no massive Media queries with every field).
 *
 * AniList is a GraphQL API: every request POSTs a query document to the single
 * GraphQL endpoint (the provider's baseUrl).
 *
 * Shared selection set for a full anime record (canonical-model fields only):
 */
export const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native userPreferred }
  description(asHtml: false)
  coverImage { extraLarge large medium }
  bannerImage
  type
  format
  status
  episodes
  duration
  season
  seasonYear
  genres
  synonyms
  startDate { year month day }
  endDate { year month day }
  averageScore
  popularity
`;

/** Fetch a single anime by AniList ID. */
export const GET_ANIME_BY_ID_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
${MEDIA_FIELDS}
  }
}
`;

/**
 * Fetch a single anime by MyAnimeList ID (AniList's `idMal` capability).
 * Used later by the identity layer - the provider only exposes the lookup.
 */
export const GET_ANIME_BY_MAL_ID_QUERY = `
query ($idMal: Int) {
  Media(idMal: $idMal, type: ANIME) {
${MEDIA_FIELDS}
  }
}
`;

/**
 * Search anime with optional filters (page, perPage, season, year, format,
 * status, genre, sort). Sorts default to SEARCH_MATCH for keyword searches and
 * POPULARITY_DESC for filter-only browsing.
 *
 * `trailer { id site }` rides along in the SAME request (no extra API call):
 * AniList's native trailer metadata for list cards (home sections, search,
 * category, top-search). Normalization + URL building live in the normalizer.
 */
export const SEARCH_ANIME_QUERY = `
query ($page: Int, $perPage: Int, $search: String, $season: MediaSeason, $seasonYear: Int, $format: MediaFormat, $status: MediaStatus, $genre: String, $sort: [MediaSort]) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage perPage }
    media(
      search: $search
      season: $season
      seasonYear: $seasonYear
      format: $format
      status: $status
      genre: $genre
      type: ANIME
      sort: $sort
    ) {
${MEDIA_FIELDS}
      trailer { id site }
    }
  }
}
`;

/** Enhanced relations (related anime) for a given AniList ID. */
export const GET_RELATIONS_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    relations {
      nodes {
        id
        idMal
        type
        format
        title { romaji english native }
        coverImage { extraLarge large medium }
        bannerImage
        episodes
        status
        season
        seasonYear
        averageScore
        genres
        relationType
      }
    }
  }
}
`;

/** Recommended anime for a given AniList ID (sorted by rating). */
export const GET_RECOMMENDATIONS_QUERY = `
query ($id: Int, $page: Int, $perPage: Int) {
  Media(id: $id, type: ANIME) {
    recommendations(page: $page, perPage: $perPage, sort: RATING_DESC) {
      nodes {
        rating
        mediaRecommendation {
          id
          idMal
          type
          format
          status
          episodes
          season
          seasonYear
          averageScore
          genres
          title { romaji english native userPreferred }
          coverImage { extraLarge large medium }
          bannerImage
        }
      }
    }
  }
}
`;

/** Seasonal anime listing (e.g. "currently airing this season"). */
export const GET_SEASONAL_ANIME_QUERY = `
query ($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int, $sort: [MediaSort]) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: $sort) {
${MEDIA_FIELDS}
    }
  }
}
`;

/** Airing schedule for a time window (epoch seconds, inclusive bounds). */
export const GET_AIRING_SCHEDULE_QUERY = `
query ($page: Int, $perPage: Int, $from: Int, $to: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    airingSchedules(airingAt_greater: $from, airingAt_lesser: $to) {
      airingAt
      episode
      media {
        id
        idMal
        title { romaji english userPreferred }
      }
    }
  }
}
`;

/**
 * Per-anime airing schedule (real episode numbers + air timestamps,
 * paginated). Used by the episode flow's AniList metadata fallback - episode
 * numbers come ONLY from actual AniList schedule entries, never fabricated.
 */
export const GET_ANIME_AIRING_SCHEDULE_QUERY = `
query ($id: Int, $page: Int, $perPage: Int) {
  Media(id: $id, type: ANIME) {
    airingSchedule(page: $page, perPage: $perPage) {
      pageInfo { total currentPage lastPage hasNextPage perPage }
      nodes { episode airingAt }
    }
  }
}
`;

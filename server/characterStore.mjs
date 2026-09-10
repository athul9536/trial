/**
 * Character card storage.
 *
 * Why this exists: cards used to live in a plain Map, so restarting the server
 * forgot every uploaded character. The browser papered over it by re-sending the
 * card it still held, which works but means a fresh page load after a restart
 * loses the character entirely.
 *
 * Design: memory is a hot cache, Redis is the durability layer.
 *
 *   store() writes to both. get() reads memory first, then Redis, and warms the
 *   cache on a hit.
 *
 * Consequence: if Redis is unreachable — not installed, container stopped,
 * network gone — everything still works exactly as it did before, just without
 * surviving a restart. No code path depends on Redis being up, which is the only
 * way it is safe to add a dependency a day before a demo.
 */

import { createClient } from "redis";

/** Cards expire rather than accumulating forever. */
const TTL_SECONDS = 60 * 60 * 24;

/** Cap on the in-memory cache, independent of Redis. */
const MAX_CACHED = 32;

const KEY_PREFIX = "framinu:character:";

function newId() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function createCharacterStore({ url, log = console.log } = {}) {
  const cache = new Map();
  let redis = null;

  if (url) {
    try {
      redis = createClient({
        url,
        socket: {
          // Fail fast rather than hanging server startup on an unreachable host.
          connectTimeout: 3000,
          // One retry, then give up and run from memory. Reconnecting forever
          // would spam the log during a demo.
          reconnectStrategy: (retries) => (retries > 1 ? false : 500),
        },
      });

      // Without a listener, a connection error becomes an unhandled exception
      // and takes the whole server down. That would turn an optional dependency
      // into a fatal one.
      redis.on("error", (err) => {
        if (redis?.isReady) log(`[store] redis error: ${err.message}`);
      });

      await redis.connect();
      await redis.ping();
      log(`[store] redis connected, cards persist across restarts`);
    } catch (err) {
      // node-redis can throw an AggregateError whose message is empty, so fall
      // through to the code and name before giving up on describing it.
      const reason =
        err?.message ||
        err?.code ||
        err?.errors?.[0]?.message ||
        err?.name ||
        String(err);
      log(`[store] redis unavailable (${reason}); using memory only`);
      try {
        await redis?.destroy?.();
      } catch {}
      redis = null;
    }
  } else {
    log("[store] REDIS_URL not set; using memory only");
  }

  const rememberLocally = (id, card) => {
    cache.set(id, card);
    while (cache.size > MAX_CACHED) {
      cache.delete(cache.keys().next().value);
    }
  };

  return {
    get backend() {
      return redis?.isReady ? "redis" : "memory";
    },

    /** @returns {Promise<string>} the new card id */
    async store(card) {
      const id = newId();
      rememberLocally(id, card);

      if (redis?.isReady) {
        try {
          await redis.setEx(KEY_PREFIX + id, TTL_SECONDS, JSON.stringify(card));
        } catch (err) {
          // Non-fatal: the card is already in the cache, so this session works.
          log(`[store] redis write failed: ${err?.message}`);
        }
      }

      return id;
    },

    /** @returns {Promise<object|null>} the card, or null if forgotten */
    async get(id) {
      const cached = cache.get(id);
      if (cached) return cached;

      if (redis?.isReady) {
        try {
          const raw = await redis.get(KEY_PREFIX + id);
          if (raw) {
            const card = JSON.parse(raw);
            // Warm the cache so repeated connects skip the round trip.
            rememberLocally(id, card);
            return card;
          }
        } catch (err) {
          log(`[store] redis read failed: ${err?.message}`);
        }
      }

      return null;
    },

    async close() {
      try {
        await redis?.quit();
      } catch {}
    },
  };
}

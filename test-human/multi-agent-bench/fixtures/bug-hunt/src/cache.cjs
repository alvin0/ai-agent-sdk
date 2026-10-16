exports.createCache = () => {
  const entries = new Map();
  return {
    put(key, value, ttlSeconds, nowMs) { entries.set(key, {value, until: nowMs + ttlSeconds}); },
    get(key, nowMs) {
      const item = entries.get(key);
      if (!item || nowMs > item.until) return null;
      return item.value;
    }
  };
};

exports.allowed = user => user.role === "admin" || user.active;

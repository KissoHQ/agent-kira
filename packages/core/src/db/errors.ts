// PostgreSQL codes of the failures the code expects (PostgreSQL documentation, appendix A).
const uniqueViolation = "23505";
const foreignKeyViolation = "23503";

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "code" in error.cause &&
    error.cause.code === code
  );
}

// Whether a query failed because a unique value, such as an email or a project key, is taken.
export function isUniqueViolation(error: unknown): boolean {
  return hasCode(error, uniqueViolation);
}

// Whether a query failed because a row it points to, such as a client, does not exist.
export function isForeignKeyViolation(error: unknown): boolean {
  return hasCode(error, foreignKeyViolation);
}

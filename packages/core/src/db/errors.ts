// PostgreSQL code of a value that already exists in a unique column.
const uniqueViolation = "23505";

// Whether a query failed because a unique value, such as an email or a project key, is taken.
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "code" in error.cause &&
    error.cause.code === uniqueViolation
  );
}

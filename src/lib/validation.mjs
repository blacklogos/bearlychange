// Server-side validation for entry create + patch. Runs inside the write
// lock so slug uniqueness can't race with concurrent creates. Returns null
// on success or a `{ field: message }` object on failure.

export const TYPES = ['new', 'improvement', 'fix', 'breaking'];
export const STATUSES = ['draft', 'published'];

// Permissive semver — allows X.Y.Z with optional -prerelease or +build.
const VERSION_RE = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;
// URL-safe slugs: lowercase alphanumeric, hyphen-separated, no leading hyphen.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function validateSlugFormat(slug) {
  if (!isNonEmptyString(slug)) return 'must be a non-empty string';
  if (!SLUG_RE.test(slug)) return 'must match ^[a-z0-9][a-z0-9-]*$ (lowercase, alphanumeric, hyphens)';
  return null;
}

function validateVersionFormat(version) {
  if (!isNonEmptyString(version)) return 'must be a non-empty string';
  if (!VERSION_RE.test(version)) return 'must look like X.Y.Z (optionally with -prerelease or +build)';
  return null;
}

export function validateEntryCreate(body, existingEntries) {
  const errors = {};

  if (!isNonEmptyString(body.title)) errors.title = 'required, non-empty string';
  if (!isNonEmptyString(body.summary)) errors.summary = 'required, non-empty string';

  const slugErr = validateSlugFormat(body.slug);
  if (slugErr) errors.slug = slugErr;
  else if (existingEntries.some((e) => e.slug === body.slug)) errors.slug = 'already in use';

  const versionErr = validateVersionFormat(body.version);
  if (versionErr) errors.version = versionErr;

  if (body.type !== undefined && !TYPES.includes(body.type)) {
    errors.type = `must be one of: ${TYPES.join(', ')}`;
  }
  if (body.status !== undefined && !STATUSES.includes(body.status)) {
    errors.status = `must be one of: ${STATUSES.join(', ')}`;
  }

  return Object.keys(errors).length ? errors : null;
}

export function validateEntryPatch(body, existingEntries, currentId) {
  const errors = {};

  if (body.title !== undefined && !isNonEmptyString(body.title)) {
    errors.title = 'must be a non-empty string';
  }
  if (body.summary !== undefined && !isNonEmptyString(body.summary)) {
    errors.summary = 'must be a non-empty string';
  }
  if (body.slug !== undefined) {
    const slugErr = validateSlugFormat(body.slug);
    if (slugErr) errors.slug = slugErr;
    else if (existingEntries.some((e) => e.slug === body.slug && e.id !== currentId)) {
      errors.slug = 'already in use';
    }
  }
  if (body.version !== undefined) {
    const versionErr = validateVersionFormat(body.version);
    if (versionErr) errors.version = versionErr;
  }
  if (body.type !== undefined && !TYPES.includes(body.type)) {
    errors.type = `must be one of: ${TYPES.join(', ')}`;
  }
  if (body.status !== undefined && !STATUSES.includes(body.status)) {
    errors.status = `must be one of: ${STATUSES.join(', ')}`;
  }

  return Object.keys(errors).length ? errors : null;
}

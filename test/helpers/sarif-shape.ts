/**
 * A structural check of a SARIF log against the parts of the SARIF 2.1.0
 * schema (https://json.schemastore.org/sarif-2.1.0.json) that this tool
 * emits, plus what GitHub code scanning needs to show a result. Written
 * out as code rather than pulling in a JSON-schema validator. Returns
 * every problem found; an empty list means the log passes.
 */

const LEVELS = ['none', 'note', 'warning', 'error'];
const SUPPRESSION_KINDS = ['inSource', 'external'];
const SUPPRESSION_STATUSES = ['accepted', 'underReview', 'rejected'];
const COLUMN_KINDS = ['utf16CodeUnits', 'unicodeCodePoints'];

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
const isPositiveInt = (value: unknown) => Number.isInteger(value) && (value as number) >= 1;
const isNonNegativeInt = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;

function isAbsoluteUri(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** A URI reference: no whitespace or backslashes, and it resolves against a base. */
function isUriReference(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || /[\s\\]/.test(value)) return false;
  try {
    new URL(value, 'file:///base/');
    return true;
  } catch {
    return false;
  }
}

export function sarifProblems(log: unknown): string[] {
  const problems: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };

  if (!isObject(log)) return ['log is not an object'];
  check(log.version === '2.1.0', 'version must be "2.1.0"');
  check(log.$schema === undefined || isAbsoluteUri(log.$schema), '$schema must be a URI');
  if (!Array.isArray(log.runs) || log.runs.length === 0)
    return [...problems, 'runs must be a non-empty array'];

  log.runs.forEach((run: unknown, r) => {
    const at = `runs[${r}]`;
    if (!isObject(run)) return check(false, `${at} is not an object`);
    const driver = isObject(run.tool) && isObject(run.tool.driver) ? run.tool.driver : null;
    if (!driver) return check(false, `${at}.tool.driver is required`);
    check(isNonEmptyString(driver.name), `${at}.tool.driver.name is required`);
    check(
      driver.informationUri === undefined || isAbsoluteUri(driver.informationUri),
      `${at}.tool.driver.informationUri must be a URI`,
    );
    check(
      run.columnKind === undefined || COLUMN_KINDS.includes(run.columnKind as string),
      `${at}.columnKind is invalid`,
    );

    const baseIds = isObject(run.originalUriBaseIds) ? run.originalUriBaseIds : {};
    for (const [id, base] of Object.entries(baseIds)) {
      const uri = isObject(base) ? base.uri : undefined;
      check(
        isAbsoluteUri(uri) && String(uri).endsWith('/'),
        `${at}.originalUriBaseIds.${id}.uri must be an absolute URI ending in "/"`,
      );
    }

    const rules = Array.isArray(driver.rules) ? driver.rules : [];
    const ruleIds: string[] = [];
    rules.forEach((rule: unknown, i) => {
      const ruleAt = `${at}.tool.driver.rules[${i}]`;
      if (!isObject(rule)) return check(false, `${ruleAt} is not an object`);
      check(isNonEmptyString(rule.id), `${ruleAt}.id is required`);
      check(
        !ruleIds.includes(rule.id as string),
        `${ruleAt}.id "${String(rule.id)}" is not unique`,
      );
      ruleIds.push(rule.id as string);
      for (const key of ['shortDescription', 'fullDescription']) {
        if (rule[key] !== undefined) {
          check(
            isObject(rule[key]) && isNonEmptyString((rule[key] as Json).text),
            `${ruleAt}.${key}.text is required`,
          );
        }
      }
      check(
        rule.helpUri === undefined || isAbsoluteUri(rule.helpUri),
        `${ruleAt}.helpUri must be a URI`,
      );
      const tags = isObject(rule.properties) ? rule.properties.tags : undefined;
      check(
        tags === undefined || (Array.isArray(tags) && tags.every((tag) => typeof tag === 'string')),
        `${ruleAt}.properties.tags must be strings`,
      );
    });

    if (!Array.isArray(run.results)) return check(false, `${at}.results must be an array`);
    run.results.forEach((result: unknown, i) => {
      const resultAt = `${at}.results[${i}]`;
      if (!isObject(result)) return check(false, `${resultAt} is not an object`);
      check(
        isObject(result.message) && isNonEmptyString(result.message.text),
        `${resultAt}.message.text is required`,
      );
      check(
        result.level === undefined || LEVELS.includes(result.level as string),
        `${resultAt}.level is invalid`,
      );
      if (result.ruleId !== undefined) {
        check(
          ruleIds.includes(result.ruleId as string),
          `${resultAt}.ruleId has no rule in tool.driver.rules`,
        );
      }
      if (result.ruleIndex !== undefined) {
        check(
          rules[result.ruleIndex as number] !== undefined &&
            (rules[result.ruleIndex as number] as Json).id === result.ruleId,
          `${resultAt}.ruleIndex does not point at its ruleId`,
        );
      }

      const locations = Array.isArray(result.locations) ? result.locations : [];
      check(locations.length > 0, `${resultAt}.locations: GitHub code scanning needs at least one`);
      locations.forEach((location: unknown, l) => {
        const physical =
          isObject(location) && isObject(location.physicalLocation)
            ? location.physicalLocation
            : null;
        if (!physical)
          return check(false, `${resultAt}.locations[${l}].physicalLocation is required`);
        checkArtifactLocation(
          physical.artifactLocation,
          `${resultAt}.locations[${l}].physicalLocation.artifactLocation`,
          baseIds,
          check,
        );
        if (physical.region !== undefined)
          checkRegion(
            physical.region,
            `${resultAt}.locations[${l}].physicalLocation.region`,
            check,
          );
      });

      if (result.partialFingerprints !== undefined) {
        check(
          isObject(result.partialFingerprints) &&
            Object.values(result.partialFingerprints).every(isNonEmptyString),
          `${resultAt}.partialFingerprints values must be strings`,
        );
      }

      if (result.fixes !== undefined) {
        if (!Array.isArray(result.fixes)) return check(false, `${resultAt}.fixes must be an array`);
        result.fixes.forEach((fix: unknown, f) => {
          const fixAt = `${resultAt}.fixes[${f}]`;
          if (!isObject(fix)) return check(false, `${fixAt} is not an object`);
          check(
            fix.description === undefined ||
              (isObject(fix.description) && isNonEmptyString(fix.description.text)),
            `${fixAt}.description.text is required`,
          );
          const changes = Array.isArray(fix.artifactChanges) ? fix.artifactChanges : [];
          check(changes.length > 0, `${fixAt}.artifactChanges must be non-empty`);
          changes.forEach((change: unknown, c) => {
            const changeAt = `${fixAt}.artifactChanges[${c}]`;
            if (!isObject(change)) return check(false, `${changeAt} is not an object`);
            checkArtifactLocation(
              change.artifactLocation,
              `${changeAt}.artifactLocation`,
              baseIds,
              check,
            );
            const replacements = Array.isArray(change.replacements) ? change.replacements : [];
            check(replacements.length > 0, `${changeAt}.replacements must be non-empty`);
            replacements.forEach((replacement: unknown, p) => {
              const replacementAt = `${changeAt}.replacements[${p}]`;
              if (!isObject(replacement)) return check(false, `${replacementAt} is not an object`);
              checkRegion(replacement.deletedRegion, `${replacementAt}.deletedRegion`, check);
              check(
                replacement.insertedContent === undefined ||
                  (isObject(replacement.insertedContent) &&
                    typeof replacement.insertedContent.text === 'string'),
                `${replacementAt}.insertedContent.text must be a string`,
              );
            });
          });
        });
      }

      if (result.suppressions !== undefined) {
        if (!Array.isArray(result.suppressions))
          return check(false, `${resultAt}.suppressions must be an array`);
        result.suppressions.forEach((suppression: unknown, s) => {
          const suppressionAt = `${resultAt}.suppressions[${s}]`;
          check(
            isObject(suppression) && SUPPRESSION_KINDS.includes(suppression.kind as string),
            `${suppressionAt}.kind is invalid`,
          );
          check(
            !isObject(suppression) ||
              suppression.status === undefined ||
              SUPPRESSION_STATUSES.includes(suppression.status as string),
            `${suppressionAt}.status is invalid`,
          );
        });
      }
      check(
        result.properties === undefined || isObject(result.properties),
        `${resultAt}.properties must be an object`,
      );
    });
  });
  return problems;
}

function checkArtifactLocation(
  location: unknown,
  at: string,
  baseIds: Json,
  check: (ok: boolean, message: string) => void,
): void {
  if (!isObject(location)) return check(false, `${at} is required`);
  check(isUriReference(location.uri), `${at}.uri must be a URI reference`);
  if (location.uriBaseId !== undefined) {
    check(
      Object.hasOwn(baseIds, location.uriBaseId as string),
      `${at}.uriBaseId is not in originalUriBaseIds`,
    );
    check(
      !/^[a-z][a-z0-9+.-]*:/i.test(String(location.uri)),
      `${at}.uri must be relative when it has a uriBaseId`,
    );
  }
}

function checkRegion(
  region: unknown,
  at: string,
  check: (ok: boolean, message: string) => void,
): void {
  if (!isObject(region)) return check(false, `${at} is not an object`);
  const lineBased = region.startLine !== undefined;
  const charBased = region.charOffset !== undefined;
  check(lineBased || charBased, `${at} needs startLine or charOffset`);
  if (lineBased) {
    check(isPositiveInt(region.startLine), `${at}.startLine must be an integer ≥ 1`);
    for (const key of ['startColumn', 'endLine', 'endColumn']) {
      check(
        region[key] === undefined || isPositiveInt(region[key]),
        `${at}.${key} must be an integer ≥ 1`,
      );
    }
    const endLine = (region.endLine ?? region.startLine) as number;
    check(endLine >= (region.startLine as number), `${at}.endLine is before startLine`);
    if (
      endLine === region.startLine &&
      region.startColumn !== undefined &&
      region.endColumn !== undefined
    ) {
      check(
        (region.endColumn as number) >= (region.startColumn as number),
        `${at}.endColumn is before startColumn`,
      );
    }
  }
  if (charBased) {
    check(isNonNegativeInt(region.charOffset), `${at}.charOffset must be an integer ≥ 0`);
    check(
      region.charLength === undefined || isNonNegativeInt(region.charLength),
      `${at}.charLength must be an integer ≥ 0`,
    );
  }
  check(
    region.snippet === undefined ||
      (isObject(region.snippet) && typeof region.snippet.text === 'string'),
    `${at}.snippet.text must be a string`,
  );
}

import { TAG, unknown, isUnknown, hasUnknown } from "./values.js";
const primitive = (v) =>
  v === null || ["string", "number", "boolean", "undefined"].includes(typeof v);
const string = (v) => (primitive(v) ? String(v) : unknown("form value"));
export function newForm(format, args, limit = 128) {
  const form = { [TAG]: "form", format, entries: [], gap: null };
  if (format === "multipart" && args.length) {
    form.gap = "DOM FormData initialization";
    return form;
  }
  const initial = args[0];
  if (initial == null) return form;
  let pairs;
  if (typeof initial === "string") pairs = [...new URLSearchParams(initial)];
  else if (Array.isArray(initial)) pairs = initial;
  else if (typeof initial === "object" && !hasUnknown(initial))
    pairs = Object.entries(initial);
  else {
    form.gap = "unknown form initialization";
    return form;
  }
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || !primitive(pair[0])) {
      form.gap = "unknown form entry";
      continue;
    }
    if (form.entries.length >= limit) {
      form.gap = "form entry budget";
      break;
    }
    form.entries.push([String(pair[0]), string(pair[1])]);
  }
  return form;
}
export function formValue(form) {
  if (form.format === "multipart")
    return {
      __multipart: form.entries.map(([name, value, filename]) => ({
        name,
        value,
        ...(filename === undefined ? {} : { filename }),
      })),
      ...(form.gap ? { __unknown: form.gap } : {}),
    };
  if (form.gap || form.entries.some(([k, v]) => !primitive(k) || !primitive(v)))
    return unknown(form.gap ?? "dynamic urlencoded form");
  return new URLSearchParams(form.entries).toString();
}
export function formOperation(form, method, args, limit = 128) {
  if (method === "toString")
    return {
      value: {
        [TAG]: "serialized",
        format: form.format,
        input: form,
        value:
          form.format === "urlencoded"
            ? formValue(form)
            : unknown("multipart encoding"),
      },
    };
  const key = args[0];
  if (!primitive(key) || isUnknown(key)) {
    form.gap = "dynamic form key";
    return { value: unknown("dynamic form operation"), gap: form.gap };
  }
  const name = String(key),
    matches = form.entries.filter((e) => e[0] === name);
  if (method === "get")
    return { value: form.gap ? unknown(form.gap) : (matches[0]?.[1] ?? null) };
  if (method === "getAll")
    return { value: form.gap ? unknown(form.gap) : matches.map((e) => e[1]) };
  if (method === "has")
    return { value: form.gap ? unknown(form.gap) : Boolean(matches.length) };
  if (method === "delete") {
    form.entries = form.entries.filter((e) => e[0] !== name);
    return { value: undefined, changed: name };
  }
  if (!["append", "set"].includes(method))
    return {
      value: unknown("unsupported form method"),
      gap: "unsupported form method",
    };
  const value = form.format === "urlencoded" ? string(args[1]) : args[1];
  const entry = [name, value, ...(args[2] === undefined ? [] : [args[2]])];
  if (method === "set" && matches.length) {
    let first = true;
    form.entries = form.entries.flatMap((e) =>
      e[0] !== name ? [e] : first ? ((first = false), [entry]) : [],
    );
  } else if (form.entries.length < limit) form.entries.push(entry);
  else {
    form.gap = "form entry budget";
    return { value: undefined, gap: form.gap };
  }
  return { value: undefined, changed: name };
}

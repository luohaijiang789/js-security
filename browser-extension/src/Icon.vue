<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 });
const paths: Record<string, string> = {
  activity: "M3 12h4l3-8 4 16 3-8h4",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  layers: "m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5",
  filter: "M3 5h18M6 12h12M10 19h4",
  database:
    "M20 6c0 2-3.6 4-8 4S4 8 4 6s3.6-4 8-4 8 2 8 4ZM4 6v12c0 2 3.6 4 8 4s8-2 8-4V6M4 12c0 2 3.6 4 8 4s8-2 8-4",
  clock: "M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  help: "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4M12 17h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  plus: "M12 5v14M5 12h14",
  search: "m21 21-5-5M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4",
  arrow: "m9 5 7 7-7 7",
  back: "m15 5-7 7 7 7",
  close: "m6 6 12 12M6 18 18 6",
  copy: "M9 9h12v12H9zM5 15H3V3h12v2",
  external: "M14 3h7v7m-11 4L21 3M9 3H3v18h18v-6",
  refresh:
    "M20 7v5h-5M4 17v-5h5M5.2 8a8 8 0 0 1 13.2-3L20 7M4 17l1.6 2A8 8 0 0 0 19 16",
  check: "m5 12 4 4L19 6",
  shield: "m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Zm-4 10 3 3 5-6",
  pause: "M8 4v16M16 4v16",
  play: "m7 3 15 9-15 9V3Z",
  stop: "M5 5h14v14H5z",
  code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-16-2 20",
  globe:
    "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM2 12h20M12 2c6 6 6 14 0 20-6-6-6-14 0-20Z",
  file: "M14 2H4v20h16V8l-6-6Zm0 0v6h6M8 13h8M8 17h5",
  alert: "m12 3 10 18H2L12 3Zm0 6v5m0 3h.01",
  settings:
    "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8ZM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  folder: "M3 5h6l2 3h10v12H3V5Z",
  bolt: "m13 2-9 12h7l-1 8 10-13h-8l1-7Z",
};
</script>
<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] ?? paths.file" />
  </svg>
</template>

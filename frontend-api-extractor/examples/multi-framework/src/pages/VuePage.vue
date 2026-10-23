<template><div>Vue user</div></template>
<script setup lang="ts">
import { onMounted } from 'vue';
import { loadUser } from '@/services';
onMounted(() => loadUser(8));
</script>

<template><div>Legacy user</div></template>
<script>
import { loadUser } from '@/services';
export default {
  methods: {
    refresh() { return loadUser(9); }
  }
};
</script>

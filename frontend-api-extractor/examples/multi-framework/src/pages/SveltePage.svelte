<script lang="ts">
import { onMount } from 'svelte';
import { loadUser } from '@/services';
onMount(() => loadUser(10));
</script>
<p>Svelte user</p>

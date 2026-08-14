<template>
  <figure>
    <img :src="imageUrl" />
    <figcaption>{{ caption }}</figcaption>
  </figure>
</template>

<script setup lang="ts">
interface VueTypedMissingAltProps {
  imageUrl: string;
  caption: string;
}

defineProps<VueTypedMissingAltProps>();
</script>

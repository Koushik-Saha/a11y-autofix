<!--
  The Vue counterpart: :src resolves to a <script setup> constant and
  @click to a handler imported from a local file.
-->
<script setup lang="ts">
import { archiveProject } from './lib/projectActions';

const avatarUrl = '/img/team/ceo-portrait.jpg';
</script>

<template>
  <div>
    <img :src="avatarUrl" />
    <button @click="archiveProject">
      <svg width="16" height="16" aria-hidden="true" focusable="false">
        <rect x="1" y="3" width="14" height="10" stroke="currentColor" />
      </svg>
    </button>
  </div>
</template>

<!--
  Vue counterpart of LowContrastText.tsx: light gray on white (~1.6:1).
  Detected only in browser mode; jsdom mode cannot measure contrast.
-->
<template>
  <p style="color: #cccccc; background-color: #ffffff">
    This text has very low contrast against its background.
  </p>
</template>

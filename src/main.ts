import { createApp } from 'vue';
// Bootstrap first, then our styles — style.css overrides Bootstrap's button/badge accents (the
// red/orange theme), and same-specificity overrides only win when they cascade *after* Bootstrap.
import 'bootstrap/dist/css/bootstrap.min.css';
import './style.css';
import App from './App.vue';
import { createPinia } from 'pinia';
import { i18n } from './i18n/index.ts';

const app = createApp(App);
app.use(createPinia());
app.use(i18n);
document.documentElement.lang = i18n.global.locale.value;

app.mount('#app');

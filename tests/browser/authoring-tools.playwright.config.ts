import { defineConfig } from '@playwright/test';
import publishing from './authoring-publishing.playwright.config.js';

export default defineConfig(publishing, { testMatch: 'authoring-tools.acceptance.ts' });

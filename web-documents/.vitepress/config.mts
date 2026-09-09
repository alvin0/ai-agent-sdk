import { defineConfig, type DefaultTheme } from 'vitepress'
import sidebar from './sidebar.json' with { type: 'json' }

const sidebars = sidebar as { en: DefaultTheme.SidebarItem[]; vi: DefaultTheme.SidebarItem[] }

export default defineConfig({
  title: 'AI Agent SDK',
  description: 'Provider-neutral TypeScript SDK for building AI agents.',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  metaChunk: true,

  locales: {
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      themeConfig: {
        nav: [
          { text: 'Introduction', link: '/en/01-introduction/' },
          { text: 'Agents', link: '/en/02-agents/' },
          { text: 'Tools', link: '/en/03-tools/' },
          { text: 'API Reference', link: '/en/13-api-reference/' },
        ],
        sidebar: { '/en/': sidebars.en },
        outline: { level: [2, 3], label: 'On this page' },
        docFooter: { prev: 'Previous', next: 'Next' },
        darkModeSwitchLabel: 'Appearance',
        sidebarMenuLabel: 'Menu',
        returnToTopLabel: 'Return to top',
        lastUpdated: { text: 'Last updated' },
      },
    },
    vi: {
      label: 'Tiếng Việt',
      lang: 'vi-VN',
      link: '/vi/',
      themeConfig: {
        nav: [
          { text: 'Giới thiệu', link: '/vi/01-introduction/' },
          { text: 'Agents', link: '/vi/02-agents/' },
          { text: 'Tools', link: '/vi/03-tools/' },
          { text: 'Tham chiếu API', link: '/vi/13-api-reference/' },
        ],
        sidebar: { '/vi/': sidebars.vi },
        outline: { level: [2, 3], label: 'Trên trang này' },
        docFooter: { prev: 'Trang trước', next: 'Trang sau' },
        darkModeSwitchLabel: 'Giao diện',
        lightModeSwitchTitle: 'Chuyển sang giao diện sáng',
        darkModeSwitchTitle: 'Chuyển sang giao diện tối',
        sidebarMenuLabel: 'Mục lục',
        returnToTopLabel: 'Về đầu trang',
        langMenuLabel: 'Đổi ngôn ngữ',
        lastUpdated: { text: 'Cập nhật lần cuối' },
      },
    },
  },

  themeConfig: {
    search: {
      provider: 'local',
      options: {
        locales: {
          vi: {
            translations: {
              button: { buttonText: 'Tìm kiếm', buttonAriaLabel: 'Tìm kiếm' },
              modal: {
                displayDetails: 'Hiện chi tiết',
                resetButtonTitle: 'Xoá tìm kiếm',
                backButtonTitle: 'Quay lại',
                noResultsText: 'Không có kết quả cho',
                footer: {
                  selectText: 'để chọn',
                  navigateText: 'để di chuyển',
                  closeText: 'để đóng',
                },
              },
            },
          },
        },
      },
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'AI Agent SDK',
    },
  },
})

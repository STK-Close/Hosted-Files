# ligiacushman.com: phone menu fix and name under the logo (2026-11-27)

Three pastes. Put each one at the very END of what's already in the box. Don't delete anything.

## 1. Custom CSS
In Squarespace go to **Design > Custom CSS**. On some accounts it's **Website > Pages > Website Tools > Custom CSS**.
Paste this at the bottom, then tap Save.

```css
/* ===== Ligia's site fixes, 2026-11-27 ===== */

/* 1. Phone menu: iPhone Safari ignores taps on the plain "MENU" text unless it is marked tappable;
      also a bigger tap area (was 48x15 px) and the sale banner no longer pinned over the menu */
@media screen and (max-width:640px){
  .sqs-announcement-bar{position:relative !important;z-index:0 !important}
  #mobile-navigation li a{display:block;padding:14px 0;line-height:16px}
  #mobile-navigation-label{cursor:pointer;display:inline-block;padding:15px 24px;margin:-15px -24px;-webkit-tap-highlight-color:transparent}
}

/* 2. Name under the LC logo on every page (the logo already says the name to screen readers) */
#title-area .site-title a{display:inline-block;text-decoration:none}
#title-area .site-title a::after{
  content:"Ligia N. Cushman";
  content:"Ligia N. Cushman" / "";
  display:block;
  margin:14px 0 18px;
  font-family:'Cinzel',Georgia,serif;
  font-weight:700;
  font-size:clamp(1.15rem,6.2vw,2.2rem);
  line-height:1.15;
  letter-spacing:.08em;
  text-transform:uppercase;
  white-space:nowrap;
  color:#F4E9D8;
  text-shadow:0 2px 10px rgba(0,0,0,.9);
}
/* the home page's own name block is no longer needed */
.lc-id{display:none !important}
```

## 2. Code Injection: Header
Go to **Settings > Advanced > Code Injection**. Paste this at the bottom of the **Header** box.
It loads your Cinzel font on every page, so your name looks the same everywhere.

```html
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700&display=swap" rel="stylesheet">
```

## 3. Code Injection: Footer
On the same page, paste this at the bottom of the **Footer** box, then tap Save.

```html
<script>
/* Phone menu: open and close it ourselves, so it works even before Squarespace's own scripts finish loading (2026-11-27) */
document.addEventListener('DOMContentLoaded', function () {
  var label = document.getElementById('mobile-navigation-label');
  var nav = document.getElementById('mobile-navigation');
  if (!label || !nav) return;
  label.setAttribute('role', 'button');
  label.setAttribute('tabindex', '0');
  label.setAttribute('aria-controls', 'mobile-navigation');
  label.setAttribute('aria-expanded', 'false');
  function toggle() {
    var open = !nav.classList.contains('sqs-mobile-nav-open');
    nav.classList.toggle('sqs-mobile-nav-open', open);
    document.body.classList.toggle('sqs-mobile-nav-open', open);
    label.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  /* catch the tap before it reaches the label, so Squarespace's handler doesn't toggle it back */
  window.addEventListener('click', function (e) {
    if (e.target === label || label.contains(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); toggle(); }
  }, true);
  label.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
});
</script>
```

## Then check on your phone
Open ligiacushman.com fresh. A private tab is a good way to see it like a new visitor.
- Tap MENU: it opens. Tap CLOSE: it closes.
- You see your name under the LC logo on the home page, Events, Shop and About.

## Good to know
- Code Injection needs a Squarespace Business plan or higher. If the Code Injection page asks you to upgrade, tell me and I will find another way.
- On iPhones older than iOS 17.4, VoiceOver may read your name twice: once from the logo and once from the text. Newer iPhones read it once.
- The home page's old name block, and the "Author of..." line with it, is hidden by the CSS. To remove it for good, edit the home page, open the code block, and delete the short block that starts with `<!-- WHO YOU ARE` and ends at its closing `</div>` (about six lines).

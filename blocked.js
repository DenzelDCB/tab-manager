
const params = new URLSearchParams(
  window.location.search
);

const originalUrl = params.get("url");
const originalTitle = params.get("title");

const titleElement = document.getElementById(
  "blocked-title"
);

const urlElement = document.getElementById(
  "blocked-url"
);

const backButton = document.getElementById(
  "back-button"
);

// Display the blocked website's title.
titleElement.textContent =
  originalTitle || "Restricted Website";

// Display its URL safely.
if (originalUrl) {
  try {
    const parsedUrl = new URL(originalUrl);

    urlElement.textContent =
      parsedUrl.origin + parsedUrl.pathname;

  } catch {
    urlElement.textContent = "Unknown website";
  }
} else {
  urlElement.textContent = "Unknown website";
}

// Return to a safe page.
backButton.addEventListener("click", () => {
  window.location.replace(
    "https://family-studyapp.pages.dev/"
  );
});

# 📖 Story Brew

> **Discover stories. Get lost in words.**

**Story Brew** is a modern storytelling platform designed to provide a beautiful and immersive space for discovering and reading stories.

The project focuses on creating an engaging reading experience with a polished, responsive interface and a simple full-stack architecture.

---

## ✨ Features

### 🏠 Home

- Featured stories
- Trending stories
- Recently added stories
- Story previews
- Quick access to reading

### 🔎 Discover

Explore stories through:

- Search
- Genres
- Authors
- Ratings
- Reading time

### 📖 Story Details

Each story provides:

- Cover image
- Title
- Author
- Description
- Genre
- Rating
- Reading time
- Story content

### 📚 Reading Experience

A clean and distraction-free reading interface with:

- Reading progress
- Responsive typography
- Chapter/content navigation
- Light reading mode
- Dark reading mode
- Sepia reading mode
- Font-size controls

### ❤️ Library

Users can:

- Save stories
- Like stories
- View saved stories
- Continue reading
- Track reading progress
- Manage their reading collection

### ✍️ Create Stories

Users can create and publish stories with:

- Title
- Author
- Description
- Cover image
- Genre
- Reading time
- Story content

### 📱 Responsive Design

The application is designed for:

- Desktop
- Laptop
- Tablet
- Mobile

---

## 🎨 UI & UX

Story Brew focuses heavily on visual design and user experience.

The interface includes:

- Modern editorial-style layouts
- Elegant typography
- Story-focused cards
- Smooth transitions
- Micro-interactions
- Hover effects
- Animated buttons
- Loading states
- Toast notifications
- Responsive layouts
- Light / Dark / Sepia reading themes

The goal is to make reading feel immersive while keeping the interface simple and easy to navigate.

---

## 🛠 Tech Stack

### Frontend

- HTML5
- CSS3
- JavaScript
- Tailwind CSS
- Google Fonts
- Lucide Icons

### Backend

- Node.js
- Express.js
- REST APIs

### Database

- SQLite

---

## 📁 Project Structure

The project intentionally uses a minimal architecture.

```text
Story Brew/
│
├── index.html      # Frontend, styling and client-side logic
├── server.js       # Backend, REST APIs and database logic
├── package.json    # Project dependencies
└── README.md
```

The frontend is contained in a single HTML file, while the backend is contained in a single JavaScript file.

This keeps the project lightweight and easy to understand.

---

## 🔌 API

The backend exposes REST APIs for stories, search, library management, likes, and reading progress.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/stories` | Fetch stories |
| GET | `/api/stories/:id` | Fetch a specific story |
| POST | `/api/stories` | Create a story |
| PUT | `/api/stories/:id` | Update a story |
| DELETE | `/api/stories/:id` | Delete a story |
| GET | `/api/search?q=` | Search stories |
| GET | `/api/genres` | Fetch genres |
| GET | `/api/trending` | Fetch trending stories |
| GET | `/api/recommended` | Fetch recommendations |
| GET | `/api/library` | Fetch saved stories |
| POST | `/api/library` | Save a story |
| DELETE | `/api/library

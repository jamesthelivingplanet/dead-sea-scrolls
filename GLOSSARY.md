# Dead Sea Scrolls

The owner's six media lists (anime, western animation, movies, series, books, games) plus his notes and other knowledge areas, kept as an OKF bundle of markdown files that the agent reads and edits.

## Language

**Bundle**:
The OKF directory tree holding the six lists, the notes directory and any other directories of concepts.
_Avoid_: vault, database

**Concept**:
One markdown file with YAML frontmatter: a title on a list, a note, or any other piece of knowledge. Its place is its concept ID.
_Avoid_: entry, item, record (except in "bare entry")

**Concept ID**:
A concept's bundle-relative path without `.md`, e.g. `anime/86-eighty-six`. Two concepts with the same file name in different directories have different IDs.
_Avoid_: slug, filename

**List**:
One of the six top-level directories of the bundle: anime, western-animation, movies, series, books, games.
_Avoid_: category, collection. A directory that is not one of the six is an area, not a list.

**Area**:
Any bundle directory outside the six lists, such as `notes` or `learning/rust`. Created on demand when a concept is created there. Concepts in an area need an explicit type, except in `notes`, where it is Note.

**Note**:
A concept of type `Note`, normally in `notes/` or below it. Flavor comes from tags (memory, idea, decision). Carries a status, never a list status.

**List status**:
Where a concept stands on its list, held in the `list_status` frontmatter key. Each list allows only its own set of values. Only concepts in the six lists have one. Not the same as Status.
_Avoid_: status (alone), state

**Status**:
OKF's lifecycle marker in the `status` frontmatter key: draft, stable or deprecated. A fresh note is a draft. Media queries ignore it.
_Avoid_: list status (a different thing), state

**Frontmatter**:
The YAML metadata block at the top of a concept file.

**Bare entry**:
A concept missing both its runtime and its resource (watch, read, or play link). Other fields do not count.
_Avoid_: stub, placeholder

**Stale**:
A concept past its `stale_after`, or with no `verified` entry. New concepts start stale.
_Avoid_: outdated, expired

**Status move**:
Changing a concept's list status, e.g. to-watch to complete. The file stays where it is.

**Move**:
Relocating a concept to another directory or file name, which gives it a new concept ID. Moving to another list also changes its type. Moving out of the six lists drops the list status and sets status to draft; moving into the notes directory sets the type to Note.
_Avoid_: rename (alone), transfer

**Problem**:
A way a concept file breaks the bundle's rules. Inside the six lists: missing frontmatter, wrong type, or a list status not allowed in its list. In an area: only unparseable frontmatter, a missing title, or a status other than draft, stable or deprecated. A concept with an unfixed problem is flagged.
_Avoid_: error, invalid file

**Phone edit**:
A change to the bundle made outside MCP, arriving through phone sync.

**Tag**:
A label in a concept's frontmatter that groups concepts across lists and directories. A tag is not a concept.
_Avoid_: category, label (alone)

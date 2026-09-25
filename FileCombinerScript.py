from pathlib import Path

# ============================================================
# SETTINGS
# ============================================================

# File extensions to include
FILE_EXTENSIONS = {
    ".js",
    ".json",
    ".jsx",
}

# Folder names to completely ignore.
# Any folder with one of these names will be skipped,
# including everything inside it.
EXCLUDED_FOLDERS = {
    "node_modules",
    ".git",
    "dist",
    "build",
    "animations"
}

# Specific filenames to ignore.
# These are ignored wherever they appear in the project.
EXCLUDED_FILES = {
    "package.json",
    "package-lock.json",
    "eslint.config.js"
}

# Name of the generated combined file
OUTPUT_FILE = "combined_files.txt"


# ============================================================
# SCRIPT
# ============================================================

def combine_files(folder_path):
    root = Path(folder_path)

    if not root.exists():
        print(f"Folder does not exist: {root}")
        return

    if not root.is_dir():
        print(f"Not a folder: {root}")
        return

    # Normalize exclusions for case-insensitive comparison
    excluded_folders = {
        name.lower() for name in EXCLUDED_FOLDERS
    }

    excluded_files = {
        name.lower() for name in EXCLUDED_FILES
    }

    files = []
    count = 0

    # Walk through the project
    for file in root.rglob("*"):

        if not file.is_file():
            continue

        # Skip the output file
        if file.name.lower() == OUTPUT_FILE.lower():
            continue

        # Skip files with excluded names
        if file.name.lower() in excluded_files:
            continue

        # Skip files inside excluded folders
        relative_path = file.relative_to(root)

        if any(
            folder.lower() in excluded_folders
            for folder in relative_path.parts[:-1]
        ):
            continue

        # Only include selected extensions
        if file.suffix.lower() not in FILE_EXTENSIONS:
            continue
        count += 1
        files.append(file)

    # Sort files alphabetically by their relative path
    files.sort(key=lambda f: str(f.relative_to(root)).lower())

    if not files:
        print("No matching files found.")
        return

    output_path = root / OUTPUT_FILE

    with output_path.open("w", encoding="utf-8") as output:

        for index, file in enumerate(files):

            relative_path = file.relative_to(root)

            try:
                content = file.read_text(encoding="utf-8")

            except UnicodeDecodeError:
                print(f"Skipping non-UTF-8 file: {relative_path}")
                continue

            # File header
            output.write("Files written: "+ str(count) + "\n\n")
            output.write("=" * 80 + "\n")
            output.write(f"FILE: {relative_path}\n")
            output.write("=" * 80 + "\n\n")

            # File contents
            output.write(content)

            if not content.endswith("\n"):
                output.write("\n")

            # Separator
            output.write("\n")
            output.write("-" * 80 + "\n")
            output.write("-" * 80 + "\n\n")

    print()
    print("Done!")
    print(f"Files included: {len(files)}")
    print(f"Output file: {output_path}")


# ============================================================
# RUN
# ============================================================

if __name__ == "__main__":
    folder = input("Enter the project folder: ").strip()

    combine_files(folder)

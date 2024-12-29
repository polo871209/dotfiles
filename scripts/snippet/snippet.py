import argparse
import json
import os

import frontmatter


def process_markdown_files(folder_path):
    # Dictionary to store snippets grouped by their last tag
    tag_snippets = {}

    # Ensure folder_path is absolute
    folder_path = os.path.abspath(folder_path)
    print(f"Scanning directory: {folder_path}")

    # Walk through all files in the folder
    for root, dirs, files in os.walk(folder_path):
        for file in files:
            if file.endswith(".md"):
                file_path = os.path.join(root, file)
                print(f"Processing file: {file_path}")
                try:
                    # Read the markdown file
                    with open(file_path, "r", encoding="utf-8") as f:
                        post = frontmatter.load(f)

                    # Check if this is a snippet
                    if post.metadata.get("snippet", False):
                        # Get the id from frontmatter
                        snippet_id = post.metadata.get("id", "")
                        if not snippet_id:
                            print(
                                f"Warning: Skipping {file} - missing id in frontmatter"
                            )
                            continue

                        # Get tags if they exist
                        tags = post.metadata.get("tags", [])
                        if not tags:
                            print(f"Warning: Skipping {file} - no tags in frontmatter")
                            continue

                        last_tag = tags[-1]

                        # Create snippet name and prefix
                        snippet_name = f"{last_tag} {snippet_id}"
                        snippet_prefix = f"{last_tag}-{snippet_id}"

                        # Extract the code block
                        content = post.content
                        code_block = ""
                        if "```" in content:
                            # Get content between first ``` and last ```
                            start = content.find("```") + 3
                            # Skip the language identifier line
                            start = content.find("\n", start) + 1
                            end = content.rfind("```")
                            if start > 3 and end != -1:
                                code_block = content[start:end].strip()

                        if code_block:
                            # Initialize dictionary for this tag if it doesn't exist
                            if last_tag not in tag_snippets:
                                tag_snippets[last_tag] = {}

                            # Create snippet entry
                            tag_snippets[last_tag][snippet_name] = {
                                "prefix": snippet_prefix,
                                "description": snippet_name,
                                "body": code_block.split("\n"),
                            }

                except Exception as e:
                    print(f"Error processing {file}: {str(e)}")

    return tag_snippets


def save_snippets(tag_snippets):
    # Expand the home directory in the path
    base_path = os.path.expanduser("~/app/friendly-snippets/snippets/custom")

    # Save each tag's snippets to its own file
    for tag, snippets in tag_snippets.items():
        output_file = os.path.join(base_path, f"{tag}.json")
        print(f"Saving {len(snippets)} snippets to {output_file}")
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(snippets, f, indent=2)


def main():
    # Set up argument parser
    parser = argparse.ArgumentParser(description="Convert markdown files to snippets")
    parser.add_argument(
        "folder_path", help="Path to the folder containing markdown files"
    )

    args = parser.parse_args()

    # Process all markdown files
    tag_snippets = process_markdown_files(args.folder_path)

    # Save snippets to separate files based on last tag
    save_snippets(tag_snippets)

    print(f"Processing complete. Created {len(tag_snippets)} snippet files.")


if __name__ == "__main__":
    main()

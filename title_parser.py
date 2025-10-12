import re
import itertools


class MovieTitle:
    """
    Represents a supplemental title with its detected locale.
    Locales can be 'Korean', 'English', or 'Other'.
    """

    def __init__(self, text, locale):
        self.text = text
        self.locale = locale
        assert not locale or locale in ["Korean", "English", "Other"], "Invalid locale"


class MovieTitleSet:
    """
    Parses and manages a movie title string that may contain
    a main title and several supplemental titles in parentheses.
    """

    def __init__(self, raw_title):
        self.raw_title = raw_title.strip()
        self.main_title = None
        self.supplemental_titles = []
        self._parse()

    def _detect_locale(self, text):
        # Detects the primary locale of a given string.
        # It checks for Hangul characters first for 'Korean'.
        # If no Hangul, it checks if the string is mostly ASCII for 'English'.
        # Otherwise, it's classified as 'Other'.
        if any("\uac00" <= char <= "\ud7a3" for char in text):
            return "Korean"

        try:
            text.encode("ascii")
            return "English"
        except UnicodeEncodeError:
            return "Other"

    def _parse(self):
        # Uses regular expressions to find the main title and the block of supplemental titles in parentheses.
        match = re.match(r"^(.*?)\s*\((.*)\)$", self.raw_title)

        if match:
            # If parentheses are found, separate the main and supplemental parts.
            main_title_text = match.group(1).strip()
            self.main_title = MovieTitle(
                main_title_text, self._detect_locale(main_title_text)
            )

            # Split the supplemental titles by comma and create objects.
            supplemental_parts = match.group(2).split(",")
            for part in supplemental_parts:
                title_text = part.strip()
                locale = self._detect_locale(title_text)
                self.supplemental_titles.append(MovieTitle(title_text, locale))
        else:
            self.main_title = MovieTitle(
                self.raw_title, self._detect_locale(self.raw_title)
            )

        assert (
            self.main_title and len(self.main_title.text) > 0
        ), f"Main title should always be set, {self.raw_title}"

    def get_title_by_locale(self, locale):
        if not locale:
            return self.main_title.text

        for title in itertools.chain([self.main_title], self.supplemental_titles):
            if title.locale == locale:
                return title.text

        return None


if __name__ == "__main__":
    titles_to_test = [
        "Another Year",
        "아저씨",
        "The Beguiled   ( 매혹당한 사람들) ",
        "  Parasite (기생충 )",
        "기생충   (Parasite)",
        " Bravo 마이 라이프  ",
        "Soul Mate (七月與安生  ,  안녕 나의 소울메이트  )",
    ]

    for title_str in titles_to_test:
        movie = MovieTitleSet(title_str)
        print(f"Parsing '{movie.raw_title}'")
        print(
            f"  Main Title: '{movie.main_title.text}' (Locale: {movie.main_title.locale})"
        )

        if movie.supplemental_titles:
            print("  Supplemental Titles:")
            for sup_title in movie.supplemental_titles:
                print(f"    - '{sup_title.text}' (Locale: {sup_title.locale})")

        # Example of getting a specific title
        korean_title = movie.get_title_by_locale("Korean")
        print(f"  Retrieved Korean Title: '{korean_title}'\n")

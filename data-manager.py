import csv
import yaml

csv_file_path = 'input-movies.csv'
yml_file_path = 'output-movies.yml'

movies_data = []

with open(csv_file_path, mode='r', encoding='utf-8') as csv_file:
    csv_reader = csv.reader(csv_file)
    
    for row in csv_reader:
        director = row[0]
        year = int(row[1])
        title = row[2]
        country = row[3]
        
        # TODO: 제목과 연도를 기반으로 IMDB ID와 포스터 파일명을 자동으로 찾아야 합니다.
        imdb_id = "tt0468569"

        movie_entry = {
            'title': title,
            'year': year,
            'director': director,
            'country': country,
            'imdb_id': imdb_id,
        }
        movies_data.append(movie_entry)

with open(yml_file_path, mode='w', encoding='utf-8') as yml_file:
    yaml.dump(movies_data, yml_file, allow_unicode=True, sort_keys=False)

print(f"'{yml_file_path}' is successfully generated.")
